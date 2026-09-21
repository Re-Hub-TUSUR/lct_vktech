import secrets

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, DbSession, session_token
from app.core.config import settings
from app.core.redis import redis_client
from app.core.security import check_rate_limit, create_session, delete_session, hash_password, verify_password
from app.models import User
from app.schemas.auth import AuthResponse, LoginRequest, RegisterRequest, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=settings.session_ttl_hours * 3600,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterRequest, request: Request, response: Response, db: DbSession) -> AuthResponse:
    client_ip = request.client.host if request.client else "unknown"
    if not await check_rate_limit(redis_client, f"rl:register:{client_ip}", max_requests=10, window_seconds=60):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много попыток регистрации. Пожалуйста, подождите минуту.")

    email = payload.email.lower()
    if await db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Пользователь с таким email уже зарегистрирован")
    user = User(email=email, full_name=payload.full_name.strip(), password_hash=hash_password(payload.password))
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Пользователь с таким email уже зарегистрирован") from None
    token = await create_session(redis_client, user.id)
    _set_session_cookie(response, token)
    return AuthResponse(user=UserOut.model_validate(user), token=token)


@router.post("/login", response_model=AuthResponse)
async def login(payload: LoginRequest, request: Request, response: Response, db: DbSession) -> AuthResponse:
    client_ip = request.client.host if request.client else "unknown"
    email = payload.email.lower()
    if not await check_rate_limit(redis_client, f"rl:login:ip:{client_ip}", max_requests=20, window_seconds=60):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много попыток входа. Пожалуйста, подождите минуту.")
    if not await check_rate_limit(redis_client, f"rl:login:acc:{email}", max_requests=10, window_seconds=60):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много попыток входа для этого аккаунта. Попробуйте позже.")

    user = await db.scalar(select(User).where(User.email == email))
    if not verify_password(payload.password, user.password_hash if user else None) or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный email или пароль")
    token = await create_session(redis_client, user.id)
    _set_session_cookie(response, token)
    return AuthResponse(user=UserOut.model_validate(user), token=token)


@router.post("/demo", response_model=AuthResponse)
async def demo_login(request: Request, response: Response, db: DbSession) -> AuthResponse:
    """Создаёт технический аккаунт один раз и открывает для него новую сессию."""
    client_ip = request.client.host if request.client else "unknown"
    if not await check_rate_limit(redis_client, f"rl:demo:{client_ip}", max_requests=30, window_seconds=60):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много попыток демо-входа. Попробуйте через минуту.")

    email = settings.demo_user_email.lower()
    user = await db.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(
            email=email,
            full_name=settings.demo_user_name,
            password_hash=hash_password(secrets.token_urlsafe(32)),
        )
        db.add(user)
        try:
            await db.commit()
        except IntegrityError:
            # Два одновременных клика могут попытаться создать демо-пользователя.
            # После конфликта используем уже созданную учётную запись.
            await db.rollback()
            user = await db.scalar(select(User).where(User.email == email))

    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Демо-доступ временно недоступен")

    token = await create_session(redis_client, user.id)
    _set_session_cookie(response, token)
    return AuthResponse(user=UserOut.model_validate(user), token=token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response) -> None:
    token = session_token(request)
    if token:
        await delete_session(redis_client, token)
    response.delete_cookie(settings.session_cookie_name, path="/")


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user
