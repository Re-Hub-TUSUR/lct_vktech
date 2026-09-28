import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

SkillKind = Literal["all", "text", "design", "audit"]


class SkillVersion(BaseModel):
    version: str
    instruction: str
    created_at: datetime | None = None


class SkillVersionOut(BaseModel):
    """Строка списка «Версии»: номер и дата (текущая версия — первой)."""

    version: str
    created_at: datetime | None = None
    current: bool = False


class SkillExample(BaseModel):
    before: str = ""
    after: str = ""


class CustomSkillCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    description: str = Field("", max_length=1000)
    kind: SkillKind = "all"
    instruction: str = Field(min_length=1, max_length=12000)
    example: SkillExample | None = None
    enabled: bool = True


class CustomSkillUpdate(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=160)
    description: str | None = Field(None, max_length=1000)
    kind: SkillKind | None = None
    instruction: str | None = Field(None, min_length=1, max_length=12000)
    example: SkillExample | None = None
    enabled: bool | None = None


class PresetDefaultUpdate(BaseModel):
    enabled: bool


class SkillPresetOut(BaseModel):
    id: str
    title: str
    description: str
    kind: SkillKind
    version: str
    instruction: str
    example: SkillExample
    versions: list[SkillVersionOut]
    # Включён у пользователя по умолчанию (новые презентации и Студия).
    enabled: bool = False


class CustomSkillOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str
    kind: SkillKind
    version: str
    instruction: str
    # Включён по умолчанию (новые презентации и Студия).
    enabled: bool
    example: SkillExample
    history: list[SkillVersion]
    versions: list[SkillVersionOut]
    created_at: datetime
    updated_at: datetime
