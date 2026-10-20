"""LLM candidates -> validated timeline events, or rejected_extractions. Never both.

The LLM proposes events with a page number and a verbatim span. Code then:
  1. validates each candidate against `CandidateEvent` (else: invalid_candidate)
  2. checks the page exists (else: page_out_of_range)
  3. fuzzy-aligns the span to that page's OCR text with rapidfuzz; score must be
     >= span_match_threshold (else: span_not_found). The stored span is the aligned OCR
     substring, so it is verbatim page text even when the LLM normalized whitespace or case.
  4. checks any numeric value appears in the aligned span (else: value_not_in_span)
  5. parses the date in code (dates.py); a date the page does not contain is discarded.
"""

import re
import uuid
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rapidfuzz import fuzz
from sqlalchemy.orm import Session

from app.config import get_settings
from app.llm import client as llm
from app.models import DocumentPage
from app.models.timeline import EVENT_CATEGORIES
from app.pipeline.dates import RELATIVE, resolve_event_date
from app.pipeline.derive import canonical_analyte
from app.repositories.cases import DocumentPageRepository, SourceDocumentRepository
from app.repositories.timeline import RejectedExtractionRepository, TimelineEventRepository

EVENT_KINDS = ("finding", "test_ordered", "test_result", "treatment", "procedure", "history", "other")


class CandidateEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    page_number: int = Field(ge=1)
    source_text_span: str = Field(min_length=3)
    category: Literal[*EVENT_CATEGORIES]
    kind: Literal[*EVENT_KINDS]
    description: str = Field(min_length=1, max_length=500)
    date_text: str | None = None
    test_name: str | None = None
    analyte: str | None = None
    value: float | None = None
    unit: str | None = None


class LlmExtraction(BaseModel):
    """Envelope only; items are validated one by one so one bad item doesn't sink the rest."""

    events: list[dict[str, Any]]


INSTRUCTIONS = f"""Extract every clinical fact from the document pages below as `events`.
Each event is an object with:
- page_number: the number from the "=== PAGE n ===" marker the fact appears under
- source_text_span: text copied EXACTLY from that page that states the fact (one line or less)
- category: one of {list(EVENT_CATEGORIES)}
- kind: one of {list(EVENT_KINDS)}. Use "test_ordered" for a test ordered, sent, or scheduled
  whose result is NOT given in the span; "test_result" for a reported test or imaging result;
  "history" for past history or family history.
- description: a short neutral restatement of the fact (no interpretation)
- date_text: the date of THIS fact copied exactly as written (e.g. "01/09/2026", "June 2015",
  "same day", "today"). If the fact itself has no stated date, use null; do not borrow the
  note's date for history whose date is not stated.
- test_name: the test or study name for test_ordered / test_result, else null
- analyte: what a numeric result measures (e.g. "LVEF", "mass size", "hemoglobin"), else null
- value: the numeric result exactly as written (number only), else null
- unit: the unit of value (e.g. "%", "cm", "g/dL"), else null
Ignore letterheads, patient identifiers, page footers, and "synthetic document" notices.
Create one event per test when a sentence orders several tests."""


@dataclass
class ExtractionSummary:
    accepted: int = 0
    rejected: int = 0


def align_span(span: str, page_text: str) -> tuple[float, str | None]:
    """Best fuzzy match of `span` inside `page_text`. Returns (score 0..1, verbatim page substring)."""
    needle = " ".join(span.split()).lower()
    hay = page_text.replace("\n", " ").lower()  # length-preserving, so indices map back to page_text
    if not needle or len(needle) > len(hay) or len(hay) != len(page_text):
        return 0.0, None
    al = fuzz.partial_ratio_alignment(needle, hay)
    if al is None:
        return 0.0, None
    matched = page_text[al.dest_start : al.dest_end].strip()
    return al.score / 100, matched or None


def _numbers(text: str) -> list[float]:
    return [float(n) for n in re.findall(r"\d+(?:\.\d+)?", text)]


def build_prompt_text(pages: list[DocumentPage]) -> str:
    return "\n\n".join(f"=== PAGE {p.page_number} ===\n{p.ocr_text}" for p in pages)


def validate_candidate(raw: dict[str, Any], pages: dict[int, DocumentPage], threshold: float):
    """Returns ("accept", fields) or ("reject", reason, detail, score)."""
    try:
        c = CandidateEvent.model_validate(raw)
    except ValidationError as e:
        return "reject", "invalid_candidate", str(e)[:1000], None
    page = pages.get(c.page_number)
    if page is None:
        return "reject", "page_out_of_range", f"page {c.page_number} not in document", None
    score, matched = align_span(c.source_text_span, page.ocr_text)
    if matched is None or score < threshold:
        return "reject", "span_not_found", f"best match {score:.2f} < {threshold}", score
    if c.value is not None and not any(abs(n - c.value) < 1e-9 for n in _numbers(matched)):
        return "reject", "value_not_in_span", f"value {c.value} not in span {matched!r}", score

    # A stated date must actually be on the page; otherwise treat the fact as undated.
    date_text = c.date_text
    if date_text and not RELATIVE.search(date_text):
        date_score, _ = align_span(date_text, page.ocr_text)
        if date_score < threshold:
            date_text = None
    event_date, precision = resolve_event_date(date_text, page.ocr_text)

    return "accept", {
        "category": c.category,
        "event_date": event_date,
        "date_precision": precision,
        "source_page_id": page.id,
        "source_text_span": matched,
        "payload": {
            "kind": c.kind,
            "description": c.description,
            "date_text": c.date_text,
            "test_name": c.test_name,
            "analyte": canonical_analyte(c.analyte),
            "analyte_text": c.analyte,
            "value": c.value,
            "unit": c.unit,
            "llm_span": c.source_text_span,
            "match_score": round(score, 4),
        },
    }


def run_extraction(db: Session, org_id: uuid.UUID, document_id: uuid.UUID, extract=llm.extract) -> ExtractionSummary:
    doc = SourceDocumentRepository(db, org_id).get(document_id)
    if doc is None:
        raise LookupError("document not found")
    page_list = list(DocumentPageRepository(db, org_id).for_document(doc.id))
    pages = {p.page_number: p for p in page_list}
    events = TimelineEventRepository(db, org_id)
    rejected = RejectedExtractionRepository(db, org_id)
    # Re-running replaces this document's previous output.
    events.delete_where(events.model.source_page_id.in_([p.id for p in page_list]))
    rejected.delete_where(rejected.model.document_id == doc.id)

    result = extract(build_prompt_text(page_list), LlmExtraction, INSTRUCTIONS)
    threshold = get_settings().span_match_threshold
    summary = ExtractionSummary()
    for raw in result.data.events:
        outcome = validate_candidate(raw, pages, threshold)
        if outcome[0] == "accept":
            events.add(case_id=doc.case_id, extracted_by=result.model, **outcome[1])
            summary.accepted += 1
        else:
            _, reason, detail, score = outcome
            page_no = raw.get("page_number") if isinstance(raw.get("page_number"), int) else None
            rejected.add(
                case_id=doc.case_id, document_id=doc.id, page_number=page_no, reason=reason,
                detail=detail, match_score=score, candidate=raw, extracted_by=result.model,
            )
            summary.rejected += 1
    doc.status = "extracted"
    doc.error = None
    db.flush()
    return summary
