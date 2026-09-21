import logging
from contextlib import asynccontextmanager

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import FastAPI

from app.api.router import api_router
from app.core.config import settings
from app.core.db import engine
from app.core.redis import redis_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.arq = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    try:
        yield
    finally:
        await app.state.arq.aclose()
        await redis_client.aclose()
        await engine.dispose()


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)
app.include_router(api_router, prefix="/api")
