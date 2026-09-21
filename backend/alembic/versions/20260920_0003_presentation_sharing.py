"""presentation sharing and in-app notifications

Revision ID: 0003_presentation_sharing
Revises: 0002_patterns_renders
Create Date: 2026-09-20 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_presentation_sharing"
down_revision: str | None = "0002_patterns_renders"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "presentation_members",
        sa.Column("presentation_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["presentation_id"], ["presentations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("presentation_id", "user_id"),
    )
    op.create_index("ix_presentation_members_presentation_id", "presentation_members", ["presentation_id"])
    op.create_index("ix_presentation_members_user_id", "presentation_members", ["user_id"])
    op.create_table(
        "presentation_share_links",
        sa.Column("presentation_id", sa.Uuid(), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=False),
        sa.Column("token", sa.String(length=128), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["presentation_id"], ["presentations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token"),
    )
    op.create_index("ix_presentation_share_links_presentation_id", "presentation_share_links", ["presentation_id"])
    op.create_index("ix_presentation_share_links_token", "presentation_share_links", ["token"], unique=True)
    op.create_table(
        "notifications",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=50), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("body", sa.Text(), server_default="", nullable=False),
        sa.Column("href", sa.String(length=1024), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_notifications_user_id", "notifications", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_notifications_user_id", table_name="notifications")
    op.drop_table("notifications")
    op.drop_index("ix_presentation_share_links_token", table_name="presentation_share_links")
    op.drop_index("ix_presentation_share_links_presentation_id", table_name="presentation_share_links")
    op.drop_table("presentation_share_links")
    op.drop_index("ix_presentation_members_user_id", table_name="presentation_members")
    op.drop_index("ix_presentation_members_presentation_id", table_name="presentation_members")
    op.drop_table("presentation_members")
