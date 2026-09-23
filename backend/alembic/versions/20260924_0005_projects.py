"""projects (folders for grouping presentations)

Revision ID: 0005_projects
Revises: 0004_generation_plan
Create Date: 2026-09-24 10:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_projects"
down_revision: str | None = "0004_generation_plan"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        # Цвет папки — код из фиксированной палитры (см. app.schemas.project.PROJECT_COLORS).
        sa.Column("color", sa.String(length=20), nullable=False, server_default="blue"),
        # Иконка папки — ключ из фиксированного набора (см. app.schemas.project.PROJECT_ICONS).
        sa.Column("icon", sa.String(length=30), nullable=False, server_default="folder"),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_projects_owner_id", "projects", ["owner_id"])

    op.create_table(
        "project_members",
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        # viewer | editor; owner хранится в projects.owner_id.
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "user_id"),
    )
    op.create_index("ix_project_members_project_id", "project_members", ["project_id"])
    op.create_index("ix_project_members_user_id", "project_members", ["user_id"])

    op.create_table(
        "project_share_links",
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=False),
        sa.Column("token", sa.String(length=128), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token"),
    )
    op.create_index("ix_project_share_links_project_id", "project_share_links", ["project_id"])
    op.create_index("ix_project_share_links_token", "project_share_links", ["token"], unique=True)

    # Презентация принадлежит владельцу как и раньше; проект — необязательная папка для группировки.
    # При удалении проекта презентации не удаляются, просто становятся «без проекта».
    op.add_column("presentations", sa.Column("project_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_presentations_project_id_projects", "presentations", "projects", ["project_id"], ["id"], ondelete="SET NULL"
    )
    op.create_index("ix_presentations_project_id", "presentations", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_presentations_project_id", table_name="presentations")
    op.drop_constraint("fk_presentations_project_id_projects", "presentations", type_="foreignkey")
    op.drop_column("presentations", "project_id")

    op.drop_index("ix_project_share_links_token", table_name="project_share_links")
    op.drop_index("ix_project_share_links_project_id", table_name="project_share_links")
    op.drop_table("project_share_links")

    op.drop_index("ix_project_members_user_id", table_name="project_members")
    op.drop_index("ix_project_members_project_id", table_name="project_members")
    op.drop_table("project_members")

    op.drop_index("ix_projects_owner_id", table_name="projects")
    op.drop_table("projects")
