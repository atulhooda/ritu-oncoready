"""Map brief statements to rubric items. The LLM proposes (item id, quote); code accepts a
proposal only if the quote is verbatim text from the brief (whitespace-insensitive). The LLM
never scores; it only points at evidence.
"""

import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session

from app.llm import client as llm
from app.repositories.scoring import (
    AnswerKeyRepository,
    BriefItemMatchRepository,
    ReadinessBriefRepository,
    RubricItemRepository,
)

log = logging.getLogger(__name__)

# Fixed brief sections, in display order.
SECTIONS = {
    "key_changes": "Key changes since last visit",
    "pending_investigations": "Pending investigations",
    "discrepancies_noticed": "Discrepancies noticed",
    "treatment_history": "Treatment history",
    "red_flags": "Red flags",
}


class MatchCandidate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    rubric_item_id: str
    quote: str = Field(min_length=3, max_length=2000)
    section: str | None = None


class LlmMatches(BaseModel):
    matches: list[dict[str, Any]]


INSTRUCTIONS = """You are given a resident's case brief (in labeled sections) and rubric items (R1, R2, ...).
For each statement in the brief that clearly covers a rubric item, return an object in `matches`:
- rubric_item_id: the rubric item id exactly as given (e.g. "R2")
- section: the section key the quote comes from
- quote: the resident's words copied EXACTLY from the brief (a contiguous phrase or sentence)
Only match when the statement says what the rubric item describes; a statement that contradicts
the item (e.g. the wrong receptor status) is not a match. Do not grade, explain, or add advice.
Return {"matches": []} if nothing matches."""


def find_quote(quote: str, content: dict[str, str]) -> tuple[str, str] | None:
    """Locate `quote` in the brief ignoring whitespace differences. Returns (section, verbatim text)."""
    words = quote.split()
    if not words:
        return None
    pattern = re.compile(r"\s+".join(re.escape(w) for w in words))
    for section in SECTIONS:
        m = pattern.search(content.get(section) or "")
        if m:
            return section, m.group(0)
    return None


def build_prompt(content: dict[str, str], items) -> str:
    rubric = "\n".join(f"R{n}: [{i.category}] {i.description}" for n, i in enumerate(items, start=1))
    brief = "\n\n".join(f"[{key}] {label}:\n{content.get(key) or ''}" for key, label in SECTIONS.items())
    return f"RUBRIC ITEMS:\n{rubric}\n\nBRIEF:\n{brief}"


@dataclass
class MatchSummary:
    model: str = ""
    matched: int = 0
    rejected: int = 0
    unknown_items: list[str] = field(default_factory=list)


def run_matching(db: Session, org_id: uuid.UUID, brief_id: uuid.UUID, extract=llm.extract) -> MatchSummary:
    brief = ReadinessBriefRepository(db, org_id).get(brief_id)
    if brief is None:
        raise LookupError("brief not found")
    key = AnswerKeyRepository(db, org_id).current_for_case(brief.case_id)
    if key is None:
        raise LookupError("case has no final answer key")
    items = list(RubricItemRepository(db, org_id).for_answer_key(key.id))
    short_ids = {f"R{n}": item for n, item in enumerate(items, start=1)}

    result = extract(build_prompt(brief.content, items), LlmMatches, INSTRUCTIONS)
    summary = MatchSummary(model=result.model)
    accepted: dict[uuid.UUID, tuple[str, str]] = {}
    rejected: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for raw in result.data.matches:
        try:
            c = MatchCandidate.model_validate(raw)
        except ValidationError as e:
            summary.rejected += 1
            log.info("invalid match candidate: %s", e)
            continue
        item = short_ids.get(c.rubric_item_id.strip())
        if item is None:
            summary.rejected += 1
            summary.unknown_items.append(c.rubric_item_id)
            continue
        found = find_quote(c.quote, brief.content)
        if found is None:
            summary.rejected += 1
            rejected.setdefault(item.id, []).append(
                {"section": c.section, "quote": c.quote, "reason": "quote_not_in_brief"}
            )
            continue
        accepted.setdefault(item.id, found)  # first verified quote is the evidence

    matches = BriefItemMatchRepository(db, org_id)
    for item in items:
        section, quote = accepted.get(item.id, (None, None))
        row = matches.get_for(brief.id, item.id)
        if row is None:  # re-running matching keeps any faculty override on existing rows
            row = matches.add(brief_id=brief.id, rubric_item_id=item.id, matched=False)
        row.matched = item.id in accepted
        row.matched_text = quote
        row.evidence_section = section
        row.method = "llm"
        row.rejected_evidence = rejected.get(item.id, [])
        summary.matched += int(row.matched)
    db.flush()
    return summary
