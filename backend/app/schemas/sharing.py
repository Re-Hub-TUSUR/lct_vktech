import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.presentation import PresentationUserOut

ShareRole = Literal["viewer", "editor"]


class PresentationMemberOut(BaseModel):
    user: PresentationUserOut
    role: Literal["owner", "viewer", "editor"]
    created_at: datetime | None = None


class ShareLinkCreate(BaseModel):
    role: ShareRole


class ShareLinkUpdate(BaseModel):
    role: ShareRole | None = None
    is_active: bool | None = None


class ShareLinkOut(BaseModel):
    id: uuid.UUID
    token: str
    role: ShareRole
    is_active: bool
    created_at: datetime


class ShareAcceptOut(BaseModel):
    presentation_id: uuid.UUID
    title: str
    role: Literal["owner", "viewer", "editor"]


class NotificationOut(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    body: str
    href: str | None
    read_at: datetime | None
    created_at: datetime
