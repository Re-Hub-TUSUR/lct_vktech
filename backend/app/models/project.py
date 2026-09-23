import uuid
from typing import TYPE_CHECKING, ClassVar

from sqlalchemy import ForeignKey, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UUIDPk

if TYPE_CHECKING:
    from app.models.user import User


class Project(UUIDPk, Timestamps, Base):
    """Папка для группировки презентаций пользователя (например «VK Лекторий», «МЛщина», «все фичи»)."""

    __tablename__ = "projects"

    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    # Код из фиксированной палитры цветов папок macOS — app.schemas.project.PROJECT_COLORS.
    color: Mapped[str] = mapped_column(String(20), default="blue")
    # Ключ из фиксированного набора иконок — app.schemas.project.PROJECT_ICONS.
    icon: Mapped[str] = mapped_column(String(30), default="folder")

    owner: Mapped["User"] = relationship("User", lazy="raise")

    # Заполняется в deps.py для текущего пользователя, в БД не хранится.
    access_role: ClassVar[str | None] = None


class ProjectMember(UUIDPk, Timestamps, Base):
    """Доступ пользователя к чужой папке (общий проект на нескольких человек)."""

    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # viewer | editor; owner хранится в projects.owner_id.
    role: Mapped[str] = mapped_column(String(20))

    project: Mapped["Project"] = relationship(lazy="raise")
    user: Mapped["User"] = relationship(lazy="raise")


class ProjectShareLink(UUIDPk, Timestamps, Base):
    """Многоразовая capability-ссылка, добавляющая пользователя в участники папки."""

    __tablename__ = "project_share_links"

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    role: Mapped[str] = mapped_column(String(20))
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("true"))

    project: Mapped["Project"] = relationship(lazy="raise")
    created_by: Mapped["User"] = relationship(foreign_keys=[created_by_id], lazy="raise")
