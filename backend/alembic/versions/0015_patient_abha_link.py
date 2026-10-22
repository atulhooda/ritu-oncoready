"""patient ABHA link (ABDM sandbox OTP, or demo)

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-23 02:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0015'
down_revision: Union[str, Sequence[str], None] = '0014'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('patient_profiles', sa.Column('abha_number_masked', sa.String(length=20), nullable=True))
    op.add_column('patient_profiles', sa.Column('abha_address', sa.String(length=100), nullable=True))
    op.add_column('patient_profiles', sa.Column('abha_name', sa.String(length=200), nullable=True))
    op.add_column('patient_profiles', sa.Column('abha_verified_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('patient_profiles', sa.Column('abha_verified_via', sa.String(length=16), nullable=True))
    op.create_check_constraint(
        op.f("ck_patient_profiles_abha_verified_via"), "patient_profiles",
        "abha_verified_via IS NULL OR abha_verified_via IN ('abdm_sandbox', 'demo')",
    )
    op.create_check_constraint(
        op.f("ck_patient_profiles_abha_link_complete"), "patient_profiles",
        "(abha_number_masked IS NULL) = (abha_verified_at IS NULL) AND (abha_verified_at IS NULL) = (abha_verified_via IS NULL)",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f("ck_patient_profiles_abha_link_complete"), "patient_profiles", type_="check")
    op.drop_constraint(op.f("ck_patient_profiles_abha_verified_via"), "patient_profiles", type_="check")
    op.drop_column('patient_profiles', 'abha_verified_via')
    op.drop_column('patient_profiles', 'abha_verified_at')
    op.drop_column('patient_profiles', 'abha_name')
    op.drop_column('patient_profiles', 'abha_address')
    op.drop_column('patient_profiles', 'abha_number_masked')
