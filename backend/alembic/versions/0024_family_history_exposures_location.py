"""family history and exposure intake sections, patient location

Revision ID: 0024
Revises: 0023
Create Date: 2026-11-04 01:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0024'
down_revision: Union[str, Sequence[str], None] = '0023'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD = ("current_symptom", "treatment", "medication", "allergy", "recent_care", "past_history", "previous_record", "concern")
NEW = ("current_symptom", "treatment", "medication", "allergy", "recent_care", "past_history", "family_history", "exposure",
       "previous_record", "concern")


def upgrade() -> None:
    """Ritu asks about family history of cancer and exposures (tobacco, alcohol, work and home); the
    patient says where they live."""
    op.add_column('patient_profiles', sa.Column('location', sa.String(length=200), nullable=True))
    op.drop_constraint(op.f('ck_intake_facts_section'), 'intake_facts', type_='check')
    op.create_check_constraint(op.f('ck_intake_facts_section'), 'intake_facts', f"section IN {NEW}")


def downgrade() -> None:
    op.execute(f"DELETE FROM intake_facts WHERE section NOT IN {OLD}")
    op.drop_constraint(op.f('ck_intake_facts_section'), 'intake_facts', type_='check')
    op.create_check_constraint(op.f('ck_intake_facts_section'), 'intake_facts', f"section IN {OLD}")
    op.drop_column('patient_profiles', 'location')
