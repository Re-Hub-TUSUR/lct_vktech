import secrets
import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbSession, get_project_for_user
from app.models import Presentation, Project, ProjectMember, ProjectShareLink, User
from app.schemas.presentation import PresentationUserOut
from app.schemas.project import (
    ProjectCreate,
    ProjectMemberOut,
    ProjectMemberUpdate,
    ProjectOut,
    ProjectShareAcceptOut,
    ProjectShareLinkCreate,
    ProjectShareLinkOut,
    ProjectShareLinkUpdate,
    ProjectUpdate,
)

router = APIRouter(prefix="/projects", tags=["projects"])
# Без общего префикса /projects: ссылка выглядит как /project-shares/{token}, без id проекта в URL —
# так же, как /shares/{token} для презентаций.
share_router = APIRouter(tags=["projects"])


def _user_out(user: User) -> PresentationUserOut:
    return PresentationUserOut(id=user.id, full_name=user.full_name, email=user.email)


def _member_out(user: User, role: str, created_at=None) -> ProjectMemberOut:
    return ProjectMemberOut(user=_user_out(user), role=role, created_at=created_at)


def _link_out(link: ProjectShareLink) -> ProjectShareLinkOut:
    return ProjectShareLinkOut(id=link.id, token=link.token, role=link.role, is_active=link.is_active, created_at=link.created_at)


async def _project_out(db: DbSession, project: Project) -> ProjectOut:
    count = await db.scalar(select(func.count()).select_from(Presentation).where(Presentation.project_id == project.id))
    return ProjectOut(
        id=project.id,
        name=project.name,
        color=project.color,
        icon=project.icon,
        access_role=project.access_role or "owner",
        owner=_user_out(project.owner),
        presentations_count=count or 0,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


@router.get("", response_model=list[ProjectOut])
async def list_projects(user: CurrentUser, db: DbSession) -> list[ProjectOut]:
    rows = list(
        await db.execute(
            select(Project, ProjectMember.role)
            .outerjoin(ProjectMember, (ProjectMember.project_id == Project.id) & (ProjectMember.user_id == user.id))
            .where(or_(Project.owner_id == user.id, ProjectMember.user_id == user.id))
            .options(selectinload(Project.owner))
            .order_by(Project.created_at)
        )
    )
    out = []
    for project, member_role in rows:
        project.access_role = "owner" if project.owner_id == user.id else member_role
        out.append(await _project_out(db, project))
    return out


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(payload: ProjectCreate, user: CurrentUser, db: DbSession) -> ProjectOut:
    project = Project(owner_id=user.id, name=payload.name.strip(), color=payload.color, icon=payload.icon)
    db.add(project)
    await db.commit()
    project = await get_project_for_user(db, project.id, user)
    return await _project_out(db, project)


@router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(project_id: uuid.UUID, payload: ProjectUpdate, user: CurrentUser, db: DbSession) -> ProjectOut:
    project = await get_project_for_user(db, project_id, user, editable=True)
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(project, field, value.strip() if isinstance(value, str) else value)
    await db.commit()
    project = await get_project_for_user(db, project_id, user)
    return await _project_out(db, project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    """Удаляет папку. Презентации внутри не удаляются — становятся «без проекта» (project_id -> NULL)."""
    project = await get_project_for_user(db, project_id, user, owner_only=True)
    await db.delete(project)
    await db.commit()


@share_router.post("/project-shares/{token}/accept", response_model=ProjectShareAcceptOut)
async def accept_project_share_link(token: str, user: CurrentUser, db: DbSession) -> ProjectShareAcceptOut:
    link = await db.scalar(
        select(ProjectShareLink)
        .where(ProjectShareLink.token == token, ProjectShareLink.is_active.is_(True))
        .options(selectinload(ProjectShareLink.project))
    )
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ссылка доступа недействительна или отозвана")
    project = link.project
    if project.owner_id == user.id:
        return ProjectShareAcceptOut(project_id=project.id, name=project.name, role="owner")
    member = await db.scalar(
        select(ProjectMember).where(ProjectMember.project_id == project.id, ProjectMember.user_id == user.id)
    )
    if member is None:
        member = ProjectMember(project_id=project.id, user_id=user.id, role=link.role)
        db.add(member)
        await db.commit()
    return ProjectShareAcceptOut(project_id=project.id, name=project.name, role=member.role)


@router.get("/{project_id}/members", response_model=list[ProjectMemberOut])
async def list_project_members(project_id: uuid.UUID, user: CurrentUser, db: DbSession) -> list[ProjectMemberOut]:
    project = await get_project_for_user(db, project_id, user)
    members = list(
        await db.execute(
            select(ProjectMember, User)
            .join(User, User.id == ProjectMember.user_id)
            .where(ProjectMember.project_id == project.id)
            .order_by(ProjectMember.created_at)
        )
    )
    return [_member_out(project.owner, "owner", project.created_at)] + [
        _member_out(member_user, member.role, member.created_at) for member, member_user in members
    ]


@router.patch("/{project_id}/members/{member_user_id}", response_model=ProjectMemberOut)
async def update_project_member(
    project_id: uuid.UUID, member_user_id: uuid.UUID, payload: ProjectMemberUpdate, user: CurrentUser, db: DbSession
) -> ProjectMemberOut:
    project = await get_project_for_user(db, project_id, user, owner_only=True)
    if member_user_id == project.owner_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя изменить роль владельца")
    row = (
        await db.execute(
            select(ProjectMember, User)
            .join(User, User.id == ProjectMember.user_id)
            .where(ProjectMember.project_id == project.id, ProjectMember.user_id == member_user_id)
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участник не найден")
    member, member_user = row
    member.role = payload.role
    await db.commit()
    return _member_out(member_user, member.role, member.created_at)


@router.delete("/{project_id}/members/{member_user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_project_member(project_id: uuid.UUID, member_user_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    project = await get_project_for_user(db, project_id, user, owner_only=True)
    if member_user_id == project.owner_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя удалить владельца")
    member = await db.scalar(
        select(ProjectMember).where(ProjectMember.project_id == project.id, ProjectMember.user_id == member_user_id)
    )
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Участник не найден")
    await db.delete(member)
    await db.commit()


@router.get("/{project_id}/share-links", response_model=list[ProjectShareLinkOut])
async def list_project_share_links(project_id: uuid.UUID, user: CurrentUser, db: DbSession) -> list[ProjectShareLinkOut]:
    project = await get_project_for_user(db, project_id, user, owner_only=True)
    links = list(
        await db.scalars(
            select(ProjectShareLink).where(ProjectShareLink.project_id == project.id).order_by(ProjectShareLink.created_at.desc())
        )
    )
    return [_link_out(link) for link in links]


@router.post("/{project_id}/share-links", response_model=ProjectShareLinkOut, status_code=status.HTTP_201_CREATED)
async def create_project_share_link(
    project_id: uuid.UUID, payload: ProjectShareLinkCreate, user: CurrentUser, db: DbSession
) -> ProjectShareLinkOut:
    project = await get_project_for_user(db, project_id, user, owner_only=True)
    link = ProjectShareLink(project_id=project.id, created_by_id=user.id, token=secrets.token_urlsafe(24), role=payload.role)
    db.add(link)
    await db.commit()
    return _link_out(link)


@router.patch("/{project_id}/share-links/{share_link_id}", response_model=ProjectShareLinkOut)
async def update_project_share_link(
    project_id: uuid.UUID, share_link_id: uuid.UUID, payload: ProjectShareLinkUpdate, user: CurrentUser, db: DbSession
) -> ProjectShareLinkOut:
    project = await get_project_for_user(db, project_id, user, owner_only=True)
    link = await db.scalar(
        select(ProjectShareLink).where(ProjectShareLink.id == share_link_id, ProjectShareLink.project_id == project.id)
    )
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ссылка не найдена")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(link, field, value)
    await db.commit()
    return _link_out(link)
