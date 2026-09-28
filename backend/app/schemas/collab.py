"""Совместная работа в Студии: комментарии к слайдам и присутствие участников."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class CollaboratorOut(BaseModel):
    id: uuid.UUID
    full_name: str
    initials: str
    # Цвет участника в Студии: булавки, аватары, чужие выделения и курсоры.
    color: str


class CommentReplyOut(BaseModel):
    id: uuid.UUID
    author: CollaboratorOut | None
    text: str
    created_at: datetime
    updated_at: datetime


class CommentThreadOut(BaseModel):
    id: uuid.UUID
    slide_id: str
    # Булавка в координатах слайда 960×540.
    x: float
    y: float
    target: str | None
    author: CollaboratorOut | None
    text: str
    resolved: bool
    resolved_at: datetime | None
    replies: list[CommentReplyOut]
    created_at: datetime
    updated_at: datetime


class CommentCreate(BaseModel):
    slide_id: str = Field(min_length=1, max_length=64)
    x: float = Field(ge=0, le=960)
    y: float = Field(ge=0, le=540)
    target: str | None = Field(None, max_length=120)
    text: str = Field(min_length=1, max_length=4000)


class CommentReplyCreate(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class CommentUpdate(BaseModel):
    text: str | None = Field(None, min_length=1, max_length=4000)
    resolved: bool | None = None
    # Перенос булавки треда.
    x: float | None = Field(None, ge=0, le=960)
    y: float | None = Field(None, ge=0, le=540)


class PresenceUpdate(BaseModel):
    slide_id: str | None = Field(None, max_length=64)
    # Выбранный элемент слайда (title, bullets.1, shape:<id>).
    target: str | None = Field(None, max_length=120)
    # Курсор в координатах слайда 960×540; None — курсор вне слайда.
    cursor: tuple[float, float] | None = None


class PresenceOut(BaseModel):
    user: CollaboratorOut
    slide_id: str | None
    target: str | None
    cursor: tuple[float, float] | None
    updated_at: float
