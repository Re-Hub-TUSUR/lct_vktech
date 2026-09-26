"""one active share link per role (viewer / editor / coowner)

Revision ID: 0007_single_share_link_per_role
Revises: 0006_variant_review
Create Date: 2026-09-25 12:00:00
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0007_single_share_link_per_role"
down_revision: str | None = "0006_variant_review"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (таблица, колонка владельца ссылки)
_TABLES = (
    ("presentation_share_links", "presentation_id"),
    ("project_share_links", "project_id"),
)


def upgrade() -> None:
    for table, parent in _TABLES:
        # Уже накопившиеся дубликаты: оставляем самую свежую активную ссылку на роль, остальные отзываем.
        op.execute(
            f"""
            UPDATE {table} SET is_active = false
            WHERE id IN (
                SELECT id FROM (
                    SELECT id, row_number() OVER (PARTITION BY {parent}, role ORDER BY created_at DESC) AS rn
                    FROM {table} WHERE is_active
                ) ranked WHERE rn > 1
            )
            """
        )
        op.create_index(
            f"uq_{table}_active_role",
            table,
            [parent, "role"],
            unique=True,
            postgresql_where="is_active",
        )


def downgrade() -> None:
    for table, _parent in reversed(_TABLES):
        op.drop_index(f"uq_{table}_active_role", table_name=table)
