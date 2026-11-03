"""case review structured summary

Revision ID: 0023
Revises: 0022
Create Date: 2026-11-04 00:32:52.930567

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0023'
down_revision: Union[str, Sequence[str], None] = '0022'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """The junior doctor's summary as ticked points + notes (case_reviews.content)."""
    op.add_column('case_reviews', sa.Column('content', postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('case_reviews', 'content')
