from fastapi import APIRouter

from app.api.routes import auth, meta, notifications, presentations, sharing, templates, variants

api_router = APIRouter()
api_router.include_router(meta.router)
api_router.include_router(auth.router)
api_router.include_router(notifications.router)
api_router.include_router(templates.router)
api_router.include_router(presentations.router)
api_router.include_router(variants.router)
api_router.include_router(sharing.router)
