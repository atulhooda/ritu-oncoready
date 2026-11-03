"""consultations (scribe)

Revision ID: 0025
Revises: 0024
Create Date: 2026-11-04 02:01:03.982645

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '0025'
down_revision: Union[str, Sequence[str], None] = '0024'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Recorded consultations: transcript, extracted prescription draft, the approved report."""
    op.create_table('consultations',
    sa.Column('case_id', sa.Uuid(), nullable=False),
    sa.Column('doctor_user_id', sa.Uuid(), nullable=False),
    sa.Column('status', sa.String(length=16), server_default='processing', nullable=False),
    sa.Column('source', sa.String(length=16), nullable=False),
    sa.Column('recording_consent', sa.Boolean(), nullable=False),
    sa.Column('recording_key', sa.String(length=500), nullable=True),
    sa.Column('recording_mime', sa.String(length=60), nullable=True),
    sa.Column('transcript', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('doctor_speaker', sa.Integer(), nullable=True),
    sa.Column('draft', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('rejected', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('report', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('extracted_by', sa.String(length=64), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('approved_by', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("(status = 'approved') = (approved_at IS NOT NULL)", name=op.f('ck_consultations_approved_when_approved')),
    sa.CheckConstraint("source = 'typed' OR recording_key IS NOT NULL", name=op.f('ck_consultations_recording_has_audio')),
    sa.CheckConstraint("source IN ('recording', 'typed')", name=op.f('ck_consultations_source')),
    sa.CheckConstraint("status IN ('processing', 'draft', 'approved', 'failed')", name=op.f('ck_consultations_status')),
    sa.CheckConstraint('recording_consent', name=op.f('ck_consultations_recording_consent')),
    sa.ForeignKeyConstraint(['org_id', 'approved_by'], ['users.org_id', 'users.id'], name=op.f('fk_consultations_org_id_approved_by_users')),
    sa.ForeignKeyConstraint(['org_id', 'case_id'], ['patient_cases.org_id', 'patient_cases.id'], name=op.f('fk_consultations_org_id_case_id_patient_cases'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['org_id', 'doctor_user_id'], ['users.org_id', 'users.id'], name=op.f('fk_consultations_org_id_doctor_user_id_users')),
    sa.ForeignKeyConstraint(['org_id'], ['orgs.id'], name=op.f('fk_consultations_org_id_orgs'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_consultations')),
    sa.UniqueConstraint('org_id', 'id', name=op.f('uq_consultations_org_id_id'))
    )
    op.create_index(op.f('ix_consultations_case_id'), 'consultations', ['case_id'], unique=False)
    op.create_index(op.f('ix_consultations_doctor_user_id'), 'consultations', ['doctor_user_id'], unique=False)
    op.create_index(op.f('ix_consultations_org_id'), 'consultations', ['org_id'], unique=False)


def downgrade() -> None:

    op.drop_index(op.f('ix_consultations_org_id'), table_name='consultations')
    op.drop_index(op.f('ix_consultations_doctor_user_id'), table_name='consultations')
    op.drop_index(op.f('ix_consultations_case_id'), table_name='consultations')
    op.drop_table('consultations')
