"""audit review cache of a variant

Revision ID: 0006_variant_review
Revises: 0005_projects
Create Date: 2026-09-25 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006_variant_review"
down_revision: str | None = "0005_projects"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Вердикты модели-судьи по слайдам (кэш по отпечатку слайда) и состояние проверок аудита.
    op.add_column(
        "variants",
        sa.Column(
            "review",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("variants", "review")
