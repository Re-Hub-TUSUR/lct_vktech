"""deck plan of a generation run

Revision ID: 0004_generation_plan
Revises: 0003_presentation_sharing
Create Date: 2026-09-23 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004_generation_plan"
down_revision: str | None = "0003_presentation_sharing"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # План колоды (спецификации слайдов): по нему пересобирается вариант при ределе,
    # иначе рерол вернул бы тексты сценария-заглушки вместо написанных моделью.
    op.add_column(
        "generations",
        sa.Column(
            "plan",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("generations", "plan")
