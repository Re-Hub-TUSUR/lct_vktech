import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import DateTime, Float, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UUIDPk

if TYPE_CHECKING:
    from app.models.user import User


class SlideComment(UUIDPk, Timestamps, Base):
    """Комментарий к слайду в Студии. Тред — корневой комментарий (parent_id IS NULL) с булавкой
    в точке (x, y) слайда 960×540; ответы ссылаются на корень. Слайд адресуется своим id в варианте."""

    __tablename__ = "slide_comments"

    presentation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("presentations.id", ondelete="CASCADE"), index=True)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("slide_comments.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    slide_id: Mapped[str] = mapped_column(String(64))
    # Булавка треда в координатах слайда 960×540; у ответов не используется.
    x: Mapped[float] = mapped_column(Float, default=0.0)
    y: Mapped[float] = mapped_column(Float, default=0.0)
    # Элемент, к которому прикреплён тред (title, bullets.1, shape:<id>), если комментарий оставлен из панели элемента.
    target: Mapped[str | None] = mapped_column(String(120))
    text: Mapped[str] = mapped_column(Text)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    author: Mapped[Optional["User"]] = relationship(foreign_keys=[author_id], lazy="raise")
