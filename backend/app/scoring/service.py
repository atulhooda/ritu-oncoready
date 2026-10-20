import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.models import Score
from app.repositories.scoring import (
    AnswerKeyRepository,
    BriefItemMatchRepository,
    ReadinessBriefRepository,
    RubricItemRepository,
    ScoreRepository,
)
from app.scoring.engine import ENGINE_VERSION, MatchInput, RubricItemInput, score
from app.scoring.matching import find_quote, run_matching


class OverrideError(ValueError):
    pass


def compute_score(db: Session, org_id: uuid.UUID, brief_id: uuid.UUID) -> Score:
    """(Re)compute and store the score for a brief from its current matches and overrides."""
    brief = ReadinessBriefRepository(db, org_id).get(brief_id)
    if brief is None:
        raise LookupError("brief not found")
    key = AnswerKeyRepository(db, org_id).current_for_case(brief.case_id)
    if key is None:
        raise LookupError("case has no final answer key")
    items = [
        RubricItemInput(str(i.id), i.position, i.category, i.description, i.weight, i.is_critical)
        for i in RubricItemRepository(db, org_id).for_answer_key(key.id)
    ]
    matches = [
        MatchInput(str(m.rubric_item_id), m.matched, m.matched_text, m.evidence_section,
                   m.override_matched, m.override_comment)
        for m in BriefItemMatchRepository(db, org_id).for_brief(brief.id)
    ]
    result = score(items, matches)

    scores = ScoreRepository(db, org_id)
    row = scores.get_for(brief.id, key.id, ENGINE_VERSION)
    if row is None:
        row = scores.add(
            brief_id=brief.id, answer_key_id=key.id, scoring_version=ENGINE_VERSION,
            points_earned=result.points_earned, points_possible=result.points_possible,
            critical_missed=result.critical_missed, details=result.details,
        )
    else:
        row.points_earned = result.points_earned
        row.points_possible = result.points_possible
        row.critical_missed = result.critical_missed
        row.details = result.details
    brief.status = "scored"
    brief.scoring_error = None
    db.flush()
    return row


def match_and_score(db: Session, org_id: uuid.UUID, brief_id: uuid.UUID, extract=None) -> Score:
    run_matching(db, org_id, brief_id, **({"extract": extract} if extract else {}))
    return compute_score(db, org_id, brief_id)


def set_override(
    db: Session, org_id: uuid.UUID, brief_id: uuid.UUID, rubric_item_id: uuid.UUID,
    matched: bool, comment: str, user_id: uuid.UUID, evidence_quote: str | None = None,
) -> Score:
    brief = ReadinessBriefRepository(db, org_id).get(brief_id)
    if brief is None or brief.status == "draft":
        raise LookupError("brief not found")
    key = AnswerKeyRepository(db, org_id).current_for_case(brief.case_id)
    item = RubricItemRepository(db, org_id).get(rubric_item_id)
    if key is None or item is None or item.answer_key_id != key.id:
        raise LookupError("rubric item not found")
    if not comment or not comment.strip():
        raise OverrideError("a comment is required to override a match")
    found = None
    if evidence_quote:
        found = find_quote(evidence_quote, brief.content)
        if found is None:
            raise OverrideError("evidence quote is not in the brief")

    matches = BriefItemMatchRepository(db, org_id)
    row = matches.get_for(brief.id, item.id) or matches.add(
        brief_id=brief.id, rubric_item_id=item.id, matched=False, method="faculty_override"
    )
    row.override_matched = matched
    row.override_comment = comment.strip()
    row.overridden_by_user_id = user_id
    row.overridden_at = datetime.now(UTC)
    if found:
        row.evidence_section, row.matched_text = found
    db.flush()
    return compute_score(db, org_id, brief.id)


def clear_override(db: Session, org_id: uuid.UUID, brief_id: uuid.UUID, rubric_item_id: uuid.UUID) -> Score:
    row = BriefItemMatchRepository(db, org_id).get_for(brief_id, rubric_item_id)
    if row is None:
        raise LookupError("match not found")
    row.override_matched = row.override_comment = row.overridden_by_user_id = row.overridden_at = None
    db.flush()
    return compute_score(db, org_id, brief_id)
