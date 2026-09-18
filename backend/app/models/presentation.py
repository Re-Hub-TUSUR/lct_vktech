import uuid
from typing import TYPE_CHECKING, Any, Optional

from sqlalchemy import BigInteger, ForeignKey, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, CreatedAt, Timestamps, UUIDPk

if TYPE_CHECKING:
    from app.models.template import Template


class Presentation(UUIDPk, Timestamps, Base):
    __tablename__ = "presentations"

    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("templates.id", ondelete="SET NULL"), index=True
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

    template: Mapped[Optional["Template"]] = relationship("Template", lazy="raise")
    files: Mapped[list["ContentFile"]] = relationship(
        back_populates="presentation",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ContentFile.created_at",
        lazy="raise",
    )


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
