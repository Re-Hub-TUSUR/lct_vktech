import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.presentation import PresentationUserOut
from app.schemas.project_types import (
    PROJECT_COLORS,
    PROJECT_ICONS,
    ProjectAccessRole,
    ProjectColor,
    ProjectIcon,
    ProjectShareRole,
)

__all__ = [
    "PROJECT_COLORS",
    "PROJECT_ICONS",
    "ProjectAccessRole",
    "ProjectColor",
    "ProjectIcon",
    "ProjectShareRole",
    "ProjectCreate",
    "ProjectUpdate",
    "ProjectOut",
    "ProjectMemberOut",
    "ProjectMemberUpdate",
    "ProjectShareLinkCreate",
    "ProjectShareLinkUpdate",
    "ProjectShareLinkOut",
    "ProjectShareAcceptOut",
]


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=1000)
    color: ProjectColor = "blue"
    icon: ProjectIcon = "folder"


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    description: str | None = Field(None, max_length=1000)
    color: ProjectColor | None = None
    icon: ProjectIcon | None = None


class ProjectOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str = ""
    color: ProjectColor
    icon: ProjectIcon
    access_role: ProjectAccessRole
    owner: PresentationUserOut
    presentations_count: int = 0
    created_at: datetime
    updated_at: datetime


class ProjectMemberOut(BaseModel):
    user: PresentationUserOut
    role: ProjectAccessRole
    created_at: datetime | None = None


class ProjectMemberUpdate(BaseModel):
    role: ProjectShareRole


class ProjectShareLinkCreate(BaseModel):
    role: ProjectShareRole


class ProjectShareLinkUpdate(BaseModel):
    role: ProjectShareRole | None = None
    is_active: bool | None = None


class ProjectShareLinkOut(BaseModel):
    id: uuid.UUID
    token: str
    role: ProjectShareRole
    is_active: bool
    created_at: datetime


class ProjectShareAcceptOut(BaseModel):
    project_id: uuid.UUID
    name: str
    role: ProjectAccessRole
