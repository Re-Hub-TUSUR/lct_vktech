"""patterns of template slides and variant renders

Revision ID: 0002_patterns_renders
Revises: 52e0f222fe03
Create Date: 2026-09-19 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002_patterns_renders"
down_revision: str | None = "52e0f222fe03"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "templates",
        sa.Column(
            "patterns",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "variants",
        sa.Column(
            "renders",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("variants", "renders")
    op.drop_column("templates", "patterns")
