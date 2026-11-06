"""The doctor asks the patient for more before the consultation, and the patient answers: a record
they mentioned but did not upload (they upload it and link it here), or a question (answered in
words). Shown on both sides with who asked, when, and the answer."""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models import PatientCase, PatientRequest
from app.repositories.cases import SourceDocumentRepository
from app.repositories.requests import PatientRequestRepository
from app.services.review import doctor_name

MAX_TEXT = 300
MAX_ANSWER = 1000


class RequestError(ValueError):
    pass


def out(db: Session, org_id: uuid.UUID, r: PatientRequest) -> dict[str, Any]:
    doc = SourceDocumentRepository(db, org_id).get(r.answer_document_id) if r.answer_document_id else None
    return {
        "id": r.id, "kind": r.kind, "text": r.text, "status": r.status, "asked_by": doctor_name(db, org_id, r.requested_by),
        "asked_at": r.created_at, "answer": r.answer, "answered_at": r.answered_at,
        "document": {"id": doc.id, "filename": doc.filename} if doc else None,
    }


def for_case(db: Session, org_id: uuid.UUID, case_id: uuid.UUID) -> list[dict[str, Any]]:
    """Open ones first, then answered; newest first within each."""
    rows = sorted(PatientRequestRepository(db, org_id).for_case(case_id), key=lambda r: r.seq, reverse=True)
    return [out(db, org_id, r) for r in sorted(rows, key=lambda r: r.status != "open")]


def ask(db: Session, org_id: uuid.UUID, case: PatientCase, doctor_id: uuid.UUID, kind: str, text: str) -> PatientRequest:
    text = text.strip()
    if not text:
        raise RequestError("say what you need from the patient")
    r = PatientRequestRepository(db, org_id).add(case_id=case.id, requested_by=doctor_id, kind=kind, text=text[:MAX_TEXT])
    db.flush()
    return r


def _open_for(db: Session, org_id: uuid.UUID, case: PatientCase, request_id: uuid.UUID, kind: str) -> PatientRequest:
    r = PatientRequestRepository(db, org_id).get(request_id)
    if r is None or r.case_id != case.id:
        raise LookupError("request not found")
    if r.kind != kind:
        raise RequestError("this request asks for a record" if r.kind == "record" else "this request asks a question")
    return r


def answer(db: Session, org_id: uuid.UUID, case: PatientCase, request_id: uuid.UUID, text: str) -> PatientRequest:
    r = _open_for(db, org_id, case, request_id, "question")
    text = text.strip()
    if not text:
        raise RequestError("write your answer")
    r.answer, r.status, r.answered_at = text[:MAX_ANSWER], "answered", datetime.now(UTC)
    db.flush()
    return r


def attach_record(db: Session, org_id: uuid.UUID, case: PatientCase, request_id: uuid.UUID, document_id: uuid.UUID) -> PatientRequest:
    """Link a record the patient uploaded (their own) as the answer; a later upload replaces it."""
    r = _open_for(db, org_id, case, request_id, "record")
    doc = SourceDocumentRepository(db, org_id).get(document_id)
    if doc is None or doc.case_id != case.id:
        raise LookupError("record not found")
    r.answer_document_id, r.status, r.answered_at = doc.id, "answered", datetime.now(UTC)
    db.flush()
    return r
