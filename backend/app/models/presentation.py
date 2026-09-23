import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any, ClassVar, Optional

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, CreatedAt, Timestamps, UUIDPk

if TYPE_CHECKING:
    from app.models.project import Project
    from app.models.template import Template
    from app.models.user import User


class Presentation(UUIDPk, Timestamps, Base):
    __tablename__ = "presentations"

    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("templates.id", ondelete="SET NULL"), index=True
    )
    # Папка, к которой отнесена презентация. NULL — «без проекта». Удаление проекта не удаляет презентации.
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), index=True
    )
    title: Mapped[str] = mapped_column(String(300))
    # feature | product | project | initiative
    purpose: Mapped[str] = mapped_column(String(30))
    brief: Mapped[str] = mapped_column(Text, default="", server_default="")
    # Параметры генерации, схема — app.schemas.presentation.GenerationSettings.
    settings: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    # draft | generating | ready | failed
    status: Mapped[str] = mapped_column(String(20), default="draft")
    selected_variant_id: Mapped[uuid.UUID | None] = mapped_column()

    # Заполняется в deps.py для текущего пользователя, в БД не хранится.
    access_role: ClassVar[str | None] = None

    template: Mapped[Optional["Template"]] = relationship("Template", lazy="raise")
    project: Mapped[Optional["Project"]] = relationship("Project", lazy="raise")
    owner: Mapped["User"] = relationship("User", lazy="raise")
    files: Mapped[list["ContentFile"]] = relationship(
        back_populates="presentation",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ContentFile.created_at",
        lazy="raise",
    )


class PresentationMember(UUIDPk, Timestamps, Base):
    """Доступ зарегистрированного пользователя к конкретной презентации."""

    __tablename__ = "presentation_members"
    __table_args__ = (UniqueConstraint("presentation_id", "user_id"),)

    presentation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("presentations.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # viewer | editor; owner хранится в presentations.owner_id.
    role: Mapped[str] = mapped_column(String(20))

    presentation: Mapped["Presentation"] = relationship(lazy="raise")
    user: Mapped["User"] = relationship(lazy="raise")


class PresentationShareLink(UUIDPk, Timestamps, Base):
    """Многоразовая capability-ссылка, добавляющая пользователя в участники."""

    __tablename__ = "presentation_share_links"

    presentation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("presentations.id", ondelete="CASCADE"), index=True
    )
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    role: Mapped[str] = mapped_column(String(20))
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("true"))

    presentation: Mapped["Presentation"] = relationship(lazy="raise")
    created_by: Mapped["User"] = relationship(foreign_keys=[created_by_id], lazy="raise")


class Notification(UUIDPk, CreatedAt, Base):
    __tablename__ = "notifications"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(50))
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text, default="", server_default="")
    href: Mapped[str | None] = mapped_column(String(1024))
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped["User"] = relationship(lazy="raise")


class ContentFile(UUIDPk, CreatedAt, Base):
    """Файл контент-пакета: тексты, данные, описание продукта."""

    __tablename__ = "content_files"

    presentation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("presentations.id", ondelete="CASCADE"), index=True
    )
    filename: Mapped[str] = mapped_column(String(500))
    content_type: Mapped[str] = mapped_column(String(200))
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    path: Mapped[str] = mapped_column(String(1024))
    # Заполняется стадией «Анализ контент-пакета»; NULL — ещё не обрабатывался.
    extracted_text: Mapped[str | None] = mapped_column(Text)

    presentation: Mapped[Presentation] = relationship(back_populates="files", lazy="raise")
