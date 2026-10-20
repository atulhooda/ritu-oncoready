"""Celery tasks: ocr_document -> extract_document -> derive_case. Each task carries org_id
and touches data only through org-bound repositories."""

import logging
import uuid

from celery import chain

from app.db import SessionLocal
from app.pipeline.derive import run_derive
from app.pipeline.extraction import run_extraction
from app.pipeline.ocr import run_ocr
from app.repositories.cases import SourceDocumentRepository
from app.worker import celery_app

log = logging.getLogger(__name__)


def _mark_failed(org_id: uuid.UUID, document_id: uuid.UUID, error: Exception) -> None:
    with SessionLocal() as db:
        doc = SourceDocumentRepository(db, org_id).get(document_id)
        if doc is not None:
            doc.status = "failed"
            doc.error = f"{type(error).__name__}: {error}"[:2000]
            db.commit()


@celery_app.task(name="pipeline.ocr_document")
def ocr_document(org_id: str, document_id: str) -> int:
    org, doc = uuid.UUID(org_id), uuid.UUID(document_id)
    try:
        with SessionLocal() as db:
            n = run_ocr(db, org, doc)
            db.commit()
            return n
    except Exception as e:
        _mark_failed(org, doc, e)
        raise


@celery_app.task(name="pipeline.extract_document")
def extract_document(org_id: str, document_id: str) -> dict:
    org, doc = uuid.UUID(org_id), uuid.UUID(document_id)
    try:
        with SessionLocal() as db:
            summary = run_extraction(db, org, doc)
            db.commit()
            return {"accepted": summary.accepted, "rejected": summary.rejected}
    except Exception as e:
        _mark_failed(org, doc, e)
        raise


@celery_app.task(name="pipeline.derive_case")
def derive_case(org_id: str, case_id: str) -> dict:
    with SessionLocal() as db:
        result = run_derive(db, uuid.UUID(org_id), uuid.UUID(case_id))
        db.commit()
        return result


def enqueue_document(org_id: uuid.UUID, document_id: uuid.UUID, case_id: uuid.UUID):
    args = (str(org_id), str(document_id))
    return chain(
        ocr_document.si(*args), extract_document.si(*args), derive_case.si(str(org_id), str(case_id))
    ).apply_async()
