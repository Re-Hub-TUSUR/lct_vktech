"""studio: slide comments, skill examples and default presets

Revision ID: 0009_studio_comments_skills
Revises: 0008_custom_skills
Create Date: 2026-09-28 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0009_studio_comments_skills"
down_revision: str | None = "0008_custom_skills"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "slide_comments",
        sa.Column("presentation_id", sa.Uuid(), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("author_id", sa.Uuid(), nullable=True),
        sa.Column("slide_id", sa.String(64), nullable=False),
        sa.Column("x", sa.Float(), nullable=False, server_default="0"),
        sa.Column("y", sa.Float(), nullable=False, server_default="0"),
        sa.Column("target", sa.String(120), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by_id", sa.Uuid(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["presentation_id"], ["presentations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["parent_id"], ["slide_comments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["resolved_by_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_slide_comments_presentation_id", "slide_comments", ["presentation_id"])
    op.create_index("ix_slide_comments_parent_id", "slide_comments", ["parent_id"])

    # Пример «до / после» у скилла библиотеки.
    op.add_column("custom_skills", sa.Column("example_before", sa.Text(), server_default="", nullable=False))
    op.add_column("custom_skills", sa.Column("example_after", sa.Text(), server_default="", nullable=False))
    # Стандартные скиллы, которые пользователь включает по умолчанию (id вида preset:…).
    op.add_column(
        "users",
        sa.Column("default_presets", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("users", "default_presets")
    op.drop_column("custom_skills", "example_after")
    op.drop_column("custom_skills", "example_before")
    op.drop_index("ix_slide_comments_parent_id", table_name="slide_comments")
    op.drop_index("ix_slide_comments_presentation_id", table_name="slide_comments")
    op.drop_table("slide_comments")
