import uuid
from typing import Any

from sqlalchemy import ForeignKey, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamps, UUIDPk


class CustomSkill(UUIDPk, Timestamps, Base):
    __tablename__ = "custom_skills"

    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default="", server_default="")
    kind: Mapped[str] = mapped_column(String(20), default="all", server_default="all")
    current_version: Mapped[str] = mapped_column(String(30), default="1.0.0", server_default="1.0.0")
    instruction: Mapped[str] = mapped_column(Text)
    history: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, server_default=text("'[]'::jsonb"))
    enabled: Mapped[bool] = mapped_column(default=True, server_default=text("true"))
