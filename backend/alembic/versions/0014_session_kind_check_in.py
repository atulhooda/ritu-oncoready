"""session kind: pre-visit history or between-visit check-in

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-23 10:05:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0014'
down_revision: Union[str, Sequence[str], None] = '0013'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Existing sessions were all pre-visit histories.
    op.add_column('intake_sessions', sa.Column('kind', sa.String(length=16), server_default='pre_visit', nullable=False))
    op.create_check_constraint(op.f("ck_intake_sessions_kind"), "intake_sessions", "kind IN ('pre_visit', 'check_in')")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DELETE FROM intake_sessions WHERE kind = 'check_in'")  # facts and turns cascade
    op.drop_constraint(op.f("ck_intake_sessions_kind"), "intake_sessions", type_="check")
    op.drop_column('intake_sessions', 'kind')
