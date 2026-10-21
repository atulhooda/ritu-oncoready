"""Callbacks from the Ritu voice server. Authenticated by HMAC signature, not by user JWT."""

import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.orm import Session

from app.db import get_db
from app.intake import service, tasks as intake_tasks
from app.repositories.intake import IntakeSessionRepository
from app.voice import client as ritu

router = APIRouter(prefix="/integrations/ritu", tags=["integrations"])


class RituTurn(BaseModel):
    role: Literal["patient", "ritu", "system"]
    text: str
    time: datetime | None = None


class RituSessionResult(BaseModel):
    session_id: str
    external_ref: str
    status: Literal["completed", "failed", "no_input", "expired", "canceled"]
    started_at: datetime | None = None
    ended_at: datetime | None = None
    transcript: list[RituTurn] = Field(default_factory=list)


@router.post("/sessions")
async def session_finished(
    request: Request,
    x_ritu_timestamp: str | None = Header(None),
    x_ritu_signature: str | None = Header(None),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    body = await request.body()
    if not ritu.verify(x_ritu_timestamp, x_ritu_signature, body):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Bad signature")
    try:
        result = RituSessionResult.model_validate_json(body)
        prefix, org_id, session_id = result.external_ref.split(":")
        org_uuid, session_uuid = uuid.UUID(org_id), uuid.UUID(session_id)
        assert prefix == "oncoready"
    except (ValidationError, ValueError, AssertionError):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Malformed callback")

    session = IntakeSessionRepository(db, org_uuid).get(session_uuid)
    if session is None or session.ritu_session_id != result.session_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown session")
    if result.status != "completed":
        if session.status in ("created", "in_progress"):
            session.status, session.error = ("expired" if result.status == "expired" else "failed"), f"ritu: {result.status}"
            db.commit()
        return {"ok": True}
    try:
        recorded = service.record_transcript(
            db, org_uuid, session, [t.model_dump() for t in result.transcript], result.started_at, result.ended_at
        )
    except service.IntakeError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    db.commit()
    if recorded:
        intake_tasks.enqueue_summary(org_uuid, session.id)
    return {"ok": True}
