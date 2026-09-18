import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel

from app.schemas.slide import Slide
from app.schemas.template import SlideTheme


class StageOut(BaseModel):
    key: str
    title: str
    skill: str | None
    status: Literal["pending", "running", "done", "skipped", "failed"]
    detail: str | None = None
    started_at: str | None = None
    finished_at: str | None = None


class SkillRef(BaseModel):
    name: str
    title: str
    version: str
    runtime: str
    model: str | None = None


class GenerationOut(BaseModel):
    id: uuid.UUID
    presentation_id: uuid.UUID
    status: Literal["queued", "running", "done", "failed"]
    progress: int
    current_stage: str | None
    stages: list[StageOut]
    skills: list[SkillRef]
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class VariantStats(BaseModel):
    slides: int
    visuals: int
    words: int
    avg_words: int
    issues_open: int
    errors: int
    warnings: int


class VariantOut(BaseModel):
    id: uuid.UUID
    position: int
    letter: str
    name: str
    description: str
    axis: str
    profile: dict[str, Any]
    slides: list[Slide]
    stats: VariantStats
    is_selected: bool


class AxisInfo(BaseModel):
    key: str
    title: str
    description: str


class VariantsResponse(BaseModel):
    theme: SlideTheme
    axis: AxisInfo
    variants: list[VariantOut]


class PresentationBrief(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    selected_variant_id: uuid.UUID | None


class VariantDetailResponse(BaseModel):
    theme: SlideTheme
    presentation: PresentationBrief
    variant: VariantOut
