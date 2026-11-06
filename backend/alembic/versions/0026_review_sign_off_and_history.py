"""review sign-off and history

Revision ID: 0026
Revises: 0025
Create Date: 2026-11-06 15:08:03.223911

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0026'
down_revision: Union[str, Sequence[str], None] = '0025'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """The senior doctor's sign-off (reviewed_by / reviewed_at) and an append-only history of every
    change to a review: assigned, saved, sent, reviewed, returned (with the reason)."""
    op.create_table('review_events',
    sa.Column('seq', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('case_id', sa.Uuid(), nullable=False),
    sa.Column('actor_user_id', sa.Uuid(), nullable=True),
    sa.Column('action', sa.String(length=16), nullable=False),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('summary', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('org_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("action <> 'returned' OR length(btrim(note)) > 0", name=op.f('ck_review_events_returned_has_reason')),
    sa.CheckConstraint("action IN ('assigned', 'saved', 'sent', 'reviewed', 'returned')", name=op.f('ck_review_events_action')),
    sa.ForeignKeyConstraint(['org_id', 'actor_user_id'], ['users.org_id', 'users.id'], name=op.f('fk_review_events_org_id_actor_user_id_users')),
    sa.ForeignKeyConstraint(['org_id', 'case_id'], ['patient_cases.org_id', 'patient_cases.id'], name=op.f('fk_review_events_org_id_case_id_patient_cases'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['org_id'], ['orgs.id'], name=op.f('fk_review_events_org_id_orgs'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_review_events')),
    sa.UniqueConstraint('org_id', 'id', name=op.f('uq_review_events_org_id_id'))
    )
    op.create_index(op.f('ix_review_events_case_id'), 'review_events', ['case_id'], unique=False)
    op.create_index(op.f('ix_review_events_org_id'), 'review_events', ['org_id'], unique=False)
    op.add_column('case_reviews', sa.Column('reviewed_by', sa.Uuid(), nullable=True))
    op.add_column('case_reviews', sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=True))
    op.create_foreign_key(op.f('fk_case_reviews_org_id_reviewed_by_users'), 'case_reviews', 'users', ['org_id', 'reviewed_by'], ['org_id', 'id'])
    op.create_check_constraint(op.f('ck_case_reviews_reviewed_together'), 'case_reviews', "(reviewed_at IS NULL) = (reviewed_by IS NULL)")
    op.create_check_constraint(op.f('ck_case_reviews_reviewed_when_sent'), 'case_reviews', "reviewed_at IS NULL OR status = 'with_senior'")


def downgrade() -> None:
    op.drop_constraint(op.f('ck_case_reviews_reviewed_when_sent'), 'case_reviews', type_='check')
    op.drop_constraint(op.f('ck_case_reviews_reviewed_together'), 'case_reviews', type_='check')
    op.drop_constraint(op.f('fk_case_reviews_org_id_reviewed_by_users'), 'case_reviews', type_='foreignkey')
    op.drop_column('case_reviews', 'reviewed_at')
    op.drop_column('case_reviews', 'reviewed_by')
    op.drop_index(op.f('ix_review_events_org_id'), table_name='review_events')
    op.drop_index(op.f('ix_review_events_case_id'), table_name='review_events')
    op.drop_table('review_events')
