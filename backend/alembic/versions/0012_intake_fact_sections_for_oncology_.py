"""intake fact sections for oncology questions

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-22 01:58:04.384664

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0012'
down_revision: Union[str, Sequence[str], None] = '0011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


NEW = "('current_symptom', 'treatment', 'medication', 'allergy', 'recent_care', 'past_history', 'previous_record', 'concern')"
OLD = "('current_symptom', 'medication', 'allergy', 'past_history', 'previous_record')"


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_constraint(op.f("ck_intake_facts_section"), "intake_facts", type_="check")
    op.create_check_constraint(op.f("ck_intake_facts_section"), "intake_facts", f"section IN {NEW}")


def downgrade() -> None:
    """Downgrade schema."""
    # Facts in the new sections cannot be kept under the old constraint.
    op.execute("DELETE FROM intake_facts WHERE section IN ('treatment', 'recent_care', 'concern')")
    op.drop_constraint(op.f("ck_intake_facts_section"), "intake_facts", type_="check")
    op.create_check_constraint(op.f("ck_intake_facts_section"), "intake_facts", f"section IN {OLD}")
