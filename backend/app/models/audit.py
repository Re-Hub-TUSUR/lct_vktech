import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, CreatedAt, UUIDPk


class AuditIssue(UUIDPk, CreatedAt, Base):
    """Найденная аудитом проблема на слайде варианта."""

    __tablename__ = "audit_issues"

    variant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("variants.id", ondelete="CASCADE"), index=True)
    slide_id: Mapped[str | None] = mapped_column(String(40))
    check_id: Mapped[str] = mapped_column(String(80))
    # layout | template | density | integrity | content
    category: Mapped[str] = mapped_column(String(30))
    # deterministic | contextual
    kind: Mapped[str] = mapped_column(String(20))
    # error | warning | info
    severity: Mapped[str] = mapped_column(String(10))
    message: Mapped[str] = mapped_column(Text)
    # Элемент слайда для подсветки: title, bullets.2, chart, table, slide…
    target: Mapped[str | None] = mapped_column(String(120))
    # Фрагмент, на котором сработала проверка (нужен автоисправлениям).
    evidence: Mapped[str | None] = mapped_column(Text)
    fixable: Mapped[bool] = mapped_column(Boolean, default=False)
    # open | fixed | ignored
    status: Mapped[str] = mapped_column(String(10), default="open")
    # Стабильный отпечаток проблемы между перезапусками аудита.
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
