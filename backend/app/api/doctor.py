"""Doctor profile: patients who sent their Ritu session summary and records."""

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.auth.access import visible_case_or_404
from app.auth.deps import CurrentUser, require_role
from app import storage
from app.db import get_db
from app.intake import service
from app.models import Role
from app.pipeline.derive import facts_for_case, lab_flags
from app.repositories.cases import CaseRepository, SourceDocumentRepository
from app.repositories.intake import IntakeSessionRepository
from app.repositories.timeline import DiscrepancyRepository, PendingTestRepository
from app.services.timeline import build_timeline

router = APIRouter(prefix="/doctor", tags=["doctor"])
doctor_only = require_role(Role.DOCTOR)


@router.get("/patients")
def list_patients(current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    out = []
    for case in CaseRepository(db, current.org_id).published_intake():
        history = service.session_history(db, current.org_id, case.id)
        details = service.patient_details(db, current.org_id, case.patient_user_id)
        out.append({
            "case_id": case.id,
            "name": case.title,
            "age": details["age"],
            "sex": details["sex"],
            "cancer_type": details["cancer_type"],
            "published_at": case.published_at,
            "symptoms": service.current_symptom_labels(history),
            "conversations": len(history),
            "records": len(SourceDocumentRepository(db, current.org_id).for_case(case.id)),
            "pending_tests": len(PendingTestRepository(db, current.org_id).for_case(case.id)),
            "discrepancies": len(DiscrepancyRepository(db, current.org_id).for_case(case.id)),
            "flags": len(lab_flags(facts_for_case(db, current.org_id, case.id))),
        })
    return out


@router.get("/patients/{case_id}")
def get_patient(case_id: uuid.UUID, current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)):
    case = visible_case_or_404(db, current, case_id)  # published intake cases only
    return {
        "case_id": case.id,
        "name": case.title,
        "published_at": case.published_at,
        "details": service.patient_details(db, current.org_id, case.patient_user_id),
        "summary": service.build_summary(db, current.org_id, case.id),
        "sessions": service.session_history(db, current.org_id, case.id),
        "records": service.records(db, current.org_id, case.id),
        "timeline": build_timeline(db, current.org_id, case.id),
    }


@router.get("/patients/{case_id}/sessions/{session_id}/recording", response_class=FileResponse)
def session_recording(
    case_id: uuid.UUID, session_id: uuid.UUID,
    current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db),
):
    case = visible_case_or_404(db, current, case_id)  # sent intake cases only
    session = IntakeSessionRepository(db, current.org_id).get(session_id)
    if session is None or session.case_id != case.id or not session.recording_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")
    path = storage.path(session.recording_key)
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")
    return FileResponse(path, media_type=session.recording_mime or "application/octet-stream")
