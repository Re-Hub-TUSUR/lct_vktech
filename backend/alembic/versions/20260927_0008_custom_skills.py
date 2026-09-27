"""custom skill library"""
from collections.abc import Sequence
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0008_custom_skills"
down_revision: str | None = "0007_single_share_link_per_role"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

def upgrade() -> None:
    op.create_table(
        "custom_skills",
        sa.Column("owner_id", sa.Uuid(), nullable=False), sa.Column("title", sa.String(160), nullable=False),
        sa.Column("description", sa.Text(), server_default="", nullable=False), sa.Column("kind", sa.String(20), server_default="all", nullable=False),
        sa.Column("current_version", sa.String(30), server_default="1.0.0", nullable=False), sa.Column("instruction", sa.Text(), nullable=False),
        sa.Column("history", postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False), sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"), sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_custom_skills_owner_id", "custom_skills", ["owner_id"])

def downgrade() -> None:
    op.drop_index("ix_custom_skills_owner_id", table_name="custom_skills")
    op.drop_table("custom_skills")
