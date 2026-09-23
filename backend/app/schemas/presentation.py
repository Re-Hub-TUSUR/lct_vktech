import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.project_types import ProjectColor, ProjectIcon
from app.schemas.slide import Slide
from app.schemas.template import SlideTheme, TemplateSummary


class ProjectSummary(BaseModel):
    id: uuid.UUID
    name: str
    color: ProjectColor
    icon: ProjectIcon

Purpose = Literal["feature", "product", "project", "initiative"]
PresentationStatus = Literal["draft", "generating", "ready", "failed"]
VariantAxis = Literal["density", "visualization", "structure", "layouts"]
PresentationAccessRole = Literal["owner", "editor", "viewer"]
SLIDES_MIN, SLIDES_MAX, SLIDES_DEFAULT = 5, 20, 12


class GenerationSettings(BaseModel):
    slides_count: int = Field(SLIDES_DEFAULT, ge=SLIDES_MIN, le=SLIDES_MAX)
    language: Literal["ru", "en"] = "ru"
    tone: Literal["business", "neutral", "inspiring"] = "business"
    audience: str = Field("", max_length=300)
    # Ось различий между тремя вариантами вёрстки.
    variant_axis: VariantAxis = "density"
    # Задача со звёздочкой: генерация изображений моделью text-to-image.
    generate_images: bool = False
    speaker_notes: bool = True


class PresentationCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    purpose: Purpose = "product"
    brief: str = Field("", max_length=20000)
    template_id: uuid.UUID
    project_id: uuid.UUID | None = None
    settings: GenerationSettings = Field(default_factory=GenerationSettings)


class PresentationUpdate(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    purpose: Purpose | None = None
    brief: str | None = Field(None, max_length=20000)
    template_id: uuid.UUID | None = None
    # Explicit None должен уметь очищать проект («убрать из папки»), поэтому проверяем через model_fields_set, а не is not None.
    project_id: uuid.UUID | None = None
    settings: GenerationSettings | None = None


class ContentFileOut(BaseModel):
    id: uuid.UUID
    filename: str
    content_type: str
    size: int
    has_text: bool
    created_at: datetime


class PresentationUserOut(BaseModel):
    id: uuid.UUID
    full_name: str
    email: str


class PresentationOut(BaseModel):
    id: uuid.UUID
    title: str
    purpose: Purpose
    brief: str
    settings: GenerationSettings
    status: PresentationStatus
    template_id: uuid.UUID | None
    template: TemplateSummary | None
    project_id: uuid.UUID | None
    project: ProjectSummary | None
    selected_variant_id: uuid.UUID | None
    access_role: PresentationAccessRole
    owner: PresentationUserOut
    files: list[ContentFileOut]
    created_at: datetime
    updated_at: datetime


class PresentationListItem(BaseModel):
    id: uuid.UUID
    title: str
    purpose: Purpose
    status: PresentationStatus
    template_name: str | None
    project: ProjectSummary | None
    theme: SlideTheme | None
    cover: Slide | None
    # Рендер обложки выбранного варианта, если он актуален.
    cover_image: str | None = None
    slides_count: int | None
    selected_variant_id: uuid.UUID | None
    access_role: PresentationAccessRole
    owner: PresentationUserOut
    updated_at: datetime


class SelectVariantRequest(BaseModel):
    variant_id: uuid.UUID
