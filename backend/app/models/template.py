import uuid
from typing import Any

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, String, Text, false, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamps, UUIDPk


class Template(UUIDPk, Timestamps, Base):
    """Шаблон презентации: исходный .pptx и результат его декомпозиции."""

    __tablename__ = "templates"

    # NULL — встроенный шаблон из контент-пакета, доступен всем пользователям.
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    file_path: Mapped[str] = mapped_column(String(1024))
    file_size: Mapped[int] = mapped_column(BigInteger, default=0)

    # processing | ready | failed
    status: Mapped[str] = mapped_column(String(20), default="processing")
    error: Mapped[str | None] = mapped_column(Text)
    parser_version: Mapped[str | None] = mapped_column(String(20))

    slide_width: Mapped[int | None] = mapped_column(BigInteger)
    slide_height: Mapped[int | None] = mapped_column(BigInteger)
    slides_count: Mapped[int | None] = mapped_column(Integer)

    # Дизайн-токены: тема, палитра, шрифты, типографическая шкала, статистика.
    tokens: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    # Макеты с плейсхолдерами и эвристической ролью.
    layouts: Mapped[list[Any]] = mapped_column(JSONB, default=list, server_default=text("'[]'::jsonb"))
    # Роль → ключ макета: title, section, agenda, content, two_columns, image, closing.
    layout_roles: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    # Паттерны слайдов-примеров: тип, слоты, повторяющиеся элементы, рендер.
    patterns: Mapped[list[Any]] = mapped_column(JSONB, default=list, server_default=text("'[]'::jsonb"))
