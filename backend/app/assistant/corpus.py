"""Everything the records assistant may answer from, for ONE case. Every read goes through
repositories constructed with the caller's org and filtered by this case id, so another patient's
records cannot enter the corpus.

Sources, each kept with its provenance:
  - measurements: read in code from OCR'd page lines (measures.readings_in) and from extracted
    timeline events that carry a value; deduplicated per page
  - evidence: extracted record facts, pending tests, page lines (raw OCR text, so facts the
    summary or the extractor left out are still findable), and patient-reported facts from Ritu
    conversations (kept apart from documented observations)
"""

import uuid
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from app.assistant.measures import Quantity, normalize_unit, quantity_for_analyte, readings_in, temperature_unit
from app.intake import service as intake
from app.pipeline.dates import page_date, parse_date
from app.repositories.cases import DocumentPageRepository, SourceDocumentRepository
from app.repositories.timeline import PendingTestRepository, TimelineEventRepository


@dataclass
class Evidence:
    id: str  # "E12", stable within one corpus
    kind: str  # record_fact | pending_test | page_line | patient_reported
    text: str  # what is searched and shown; verbatim record text for page lines
    date: date | None
    date_basis: str | None  # stated (with the fact) | document (the page's date) | conversation
    source: dict[str, Any]


@dataclass
class Measurement:
    quantity: Quantity
    value: str
    unit: str | None
    date: date | None
    date_basis: str | None
    source: dict[str, Any]

    def number(self) -> float | None:
        return None if "/" in self.value else float(self.value)


@dataclass
class Corpus:
    case_id: uuid.UUID
    evidence: list[Evidence] = field(default_factory=list)
    measurements: list[Measurement] = field(default_factory=list)
    pending: list[Evidence] = field(default_factory=list)
    documents: int = 0
    pages: int = 0
    conversations: int = 0

    def by_id(self) -> dict[str, Evidence]:
        return {e.id: e for e in self.evidence}


def _doc_source(doc, page, span: str) -> dict[str, Any]:
    return {"type": "document", "document_id": doc.id, "filename": doc.filename,
            "page_number": page.page_number, "text_span": span}


def build_corpus(db: Session, org_id: uuid.UUID, case_id: uuid.UUID) -> Corpus:
    docs = {d.id: d for d in SourceDocumentRepository(db, org_id).for_case(case_id)}
    pages = {p.id: p for p in DocumentPageRepository(db, org_id).for_case(case_id) if p.document_id in docs}
    corpus = Corpus(case_id=case_id, documents=len(docs), pages=len(pages))
    n = 0

    def add(kind: str, text: str, when: date | None, basis: str | None, source: dict[str, Any]) -> Evidence:
        nonlocal n
        n += 1
        e = Evidence(f"E{n}", kind, text, when, basis if when else None, source)
        corpus.evidence.append(e)
        return e

    seen: dict[tuple, Measurement] = {}  # (page id, quantity, value): one reading per page, dated if possible

    def add_measurement(q: Quantity, value: str, unit: str | None, when, basis, page, source):
        key = (page.id, q.key, value)
        m = Measurement(q, value, unit, when, basis if when else None, source)
        if key in seen:
            if seen[key].date is None and when is not None:  # an undated copy gives way to a dated one
                corpus.measurements[corpus.measurements.index(seen[key])] = m
                seen[key] = m
            return
        seen[key] = m
        corpus.measurements.append(m)

    # Extracted facts first: their dates were resolved by the pipeline (stated date or page date).
    for e in TimelineEventRepository(db, org_id).for_case(case_id):
        page = pages.get(e.source_page_id)
        if page is None:
            continue
        doc = docs[page.document_id]
        p = e.payload or {}
        basis = "document" if e.date_precision == "inferred" else "stated"
        when = e.event_date
        if when is None:  # no date of its own: carry the document's date, labelled as such
            when, basis = page_date(page.ocr_text), "document"
        add("record_fact", p.get("description") or e.source_text_span, when, basis,
            _doc_source(doc, page, e.source_text_span))
        q = quantity_for_analyte(p.get("analyte"))
        if q and p.get("value") is not None:
            value = f"{p['value']:g}"
            for r in readings_in(e.source_text_span):  # "124/78" is written whole in the span
                if r.quantity.key == q.key and r.value.startswith(value):
                    value = r.value
            unit = normalize_unit(p.get("unit"), q)
            if q.key == "temperature" and not p.get("unit"):
                unit = temperature_unit(float(value.split("/")[0]))
            add_measurement(q, value, unit, e.event_date, basis, page, _doc_source(doc, page, e.source_text_span))

    # Raw page lines: anything the extractor or the summary left out.
    for page in sorted(pages.values(), key=lambda p: (docs[p.document_id].filename, p.page_number)):
        doc = docs[page.document_id]
        doc_date = page_date(page.ocr_text)
        for line in page.ocr_text.splitlines():
            line = line.strip()
            if len(line) < 3:
                continue
            stated, precision = parse_date(line)
            when, basis = (stated, "stated") if stated and precision == "exact" else (doc_date, "document")
            add("page_line", line, when, basis, _doc_source(doc, page, line))
            for r in readings_in(line):
                add_measurement(r.quantity, r.value, r.unit, when, basis, page, _doc_source(doc, page, line))

    for t in PendingTestRepository(db, org_id).for_case(case_id):
        page = pages.get(t.source_page_id)
        if page is None or t.status not in ("ordered", "pending"):
            continue
        corpus.pending.append(add("pending_test", f"{t.test_name} ({t.status})", t.ordered_date, "stated",
                                  _doc_source(docs[page.document_id], page, t.source_text_span)))

    # Patient-reported: what the patient told Ritu. Never mixed with documented observations.
    history = intake.session_history(db, org_id, case_id)
    corpus.conversations = len(history)
    for s in history:
        when = s["ended_at"].date() if s["ended_at"] else None
        for section in s["sections"]:
            for f in section["facts"]:
                details = ", ".join(f"{k}: {v}" for k, v in f["details"].items() if isinstance(v, str))
                add("patient_reported", f"{section['label']}: {f['label']}" + (f" ({details})" if details else "") + f" — “{f['quote']}”",
                    when, "conversation",
                    {"type": "conversation", "session_id": s["session_id"], "session_kind": s["kind"],
                     "turn_index": f["turn_index"], "quote": f["quote"], "label": f["label"]})
    return corpus
