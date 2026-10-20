import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.pipeline.derive import facts_for_case, lab_flags
from app.repositories.cases import DocumentPageRepository, SourceDocumentRepository
from app.repositories.timeline import DiscrepancyRepository, PendingTestRepository, TimelineEventRepository

DATE_UNCLEAR = "Date unclear"


def build_timeline(db: Session, org_id: uuid.UUID, case_id: uuid.UUID) -> dict[str, Any]:
    docs = {d.id: d for d in SourceDocumentRepository(db, org_id).for_case(case_id)}
    pages = {p.id: p for p in DocumentPageRepository(db, org_id).for_case(case_id)}

    def source(page_id: uuid.UUID, span: str) -> dict[str, Any]:
        page = pages[page_id]
        doc = docs[page.document_id]
        link = f"/documents/{doc.id}/pages/{page.page_number}"
        return {
            "document_id": doc.id, "filename": doc.filename, "page_number": page.page_number,
            "page_url": link, "image_url": f"{link}/image", "text_span": span,
        }

    events = TimelineEventRepository(db, org_id).for_case(case_id)  # dated asc, then undated
    serialized = [
        {
            "id": e.id, "event_date": e.event_date, "date_precision": e.date_precision,
            "category": e.category, "description": (e.payload or {}).get("description"),
            "payload": e.payload, "source": source(e.source_page_id, e.source_text_span),
        }
        for e in events
    ]
    return {
        "case_id": case_id,
        "events": [e for e in serialized if e["event_date"] is not None],
        "date_unclear": {"label": DATE_UNCLEAR, "events": [e for e in serialized if e["event_date"] is None]},
        "pending_tests": [
            {"id": t.id, "test_name": t.test_name, "ordered_date": t.ordered_date, "status": t.status,
             "source": source(t.source_page_id, t.source_text_span)}
            for t in PendingTestRepository(db, org_id).for_case(case_id)
        ],
        "discrepancies": [
            {"id": d.id, "field": d.field, "description": d.description, "status": d.status,
             "event_ids": [d.event_a_id, d.event_b_id]}
            for d in DiscrepancyRepository(db, org_id).for_case(case_id)
        ],
        "flags": lab_flags(facts_for_case(db, org_id, case_id)),
    }
