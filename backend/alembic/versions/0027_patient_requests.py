"""patient requests

Revision ID: 0027
Revises: 0026
Create Date: 2026-11-06 17:02:22.841472

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0027'
down_revision: Union[str, Sequence[str], None] = '0026'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """A doctor asks the patient for a record they mentioned or a question; the patient answers."""
    op.create_table('patient_requests',
    sa.Column('seq', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('case_id', sa.Uuid(), nullable=False),
    sa.Column('requested_by', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('status', sa.String(length=16), server_default='open', nullable=False),
    sa.Column('answer', sa.Text(), nullable=True),
    sa.Column('answer_document_id', sa.Uuid(), nullable=True),
    sa.Column('answered_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("(status = 'answered') = (answered_at IS NOT NULL)", name=op.f('ck_patient_requests_answered_when_answered')),
    sa.CheckConstraint("kind = 'record' OR status = 'open' OR length(btrim(answer)) > 0", name=op.f('ck_patient_requests_question_answer')),
    sa.CheckConstraint("kind IN ('record', 'question')", name=op.f('ck_patient_requests_kind')),
    sa.CheckConstraint("status IN ('open', 'answered')", name=op.f('ck_patient_requests_status')),
    sa.CheckConstraint('length(btrim(text)) > 0', name=op.f('ck_patient_requests_text_not_blank')),
    sa.ForeignKeyConstraint(['org_id', 'answer_document_id'], ['source_documents.org_id', 'source_documents.id'], name=op.f('fk_patient_requests_org_id_answer_document_id_source_documents')),
    sa.ForeignKeyConstraint(['org_id', 'case_id'], ['patient_cases.org_id', 'patient_cases.id'], name=op.f('fk_patient_requests_org_id_case_id_patient_cases'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['org_id', 'requested_by'], ['users.org_id', 'users.id'], name=op.f('fk_patient_requests_org_id_requested_by_users')),
    sa.ForeignKeyConstraint(['org_id'], ['orgs.id'], name=op.f('fk_patient_requests_org_id_orgs'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_patient_requests')),
    sa.UniqueConstraint('org_id', 'id', name=op.f('uq_patient_requests_org_id_id'))
    )
    op.create_index(op.f('ix_patient_requests_case_id'), 'patient_requests', ['case_id'], unique=False)
    op.create_index(op.f('ix_patient_requests_org_id'), 'patient_requests', ['org_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_patient_requests_org_id'), table_name='patient_requests')
    op.drop_index(op.f('ix_patient_requests_case_id'), table_name='patient_requests')
    op.drop_table('patient_requests')
