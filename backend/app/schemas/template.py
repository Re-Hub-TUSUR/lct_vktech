import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel


class SurfaceColors(BaseModel):
    background: str
    text: str


class LayoutFrames(BaseModel):
    """Области макета в долях слайда: [left, top, width, height]."""

    title: list[float] | None = None
    subtitle: list[float] | None = None
    body: list[float] | None = None


class TitleSkin(BaseModel):
    color: str
    # Кегль заголовка в % ширины слайда (единицы cqw на фронтенде).
    size: float | None = None
    anchor: str | None = None
    align: str | None = None
    bold: bool | None = None


class LayoutSkin(BaseModel):
    """Оформление макета шаблона для превью: фон-рендер, цвета и области."""

    background: str
    text: str
    muted: str
    surface: str
    image: str | None = None
    frames: LayoutFrames | None = None
    title: TitleSkin


class SlideTheme(BaseModel):
    """Цвета и шрифты для отрисовки слайдов, вычисленные из токенов шаблона."""

    background: str
    text: str
    muted: str
    surface: str
    accent: str
    accents: list[str]
    # Фон и текст обложки, разделителя и финального слайда — из макетов шаблона.
    cover: SurfaceColors
    section: SurfaceColors
    closing: SurfaceColors
    heading_font: str
    body_font: str
    aspect: float
    # Ключ макета → оформление; только макеты, назначенные ролям.
    layouts: dict[str, LayoutSkin] = {}
    roles: dict[str, str | None] = {}
    patterns: list[dict[str, Any]] = []


class TemplateSummary(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    is_builtin: bool
    status: Literal["processing", "ready", "failed"]
    error: str | None
    slides_count: int | None
    layouts_count: int
    aspect_ratio: str | None
    palette: list[str]
    fonts: list[str]
    theme: SlideTheme | None
    created_at: datetime


class TemplateDetail(TemplateSummary):
    file_size: int
    parser_version: str | None
    tokens: dict[str, Any]
    layouts: list[dict[str, Any]]
    layout_roles: dict[str, Any]
    patterns: list[dict[str, Any]]
