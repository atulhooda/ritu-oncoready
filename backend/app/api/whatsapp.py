"""Meta WhatsApp webhook: confirms patients' "JOIN <clinic> <code>" messages (app/auth/signup.py).
Point the Meta app's webhook here, or forward its calls unchanged (raw body + X-Hub-Signature-256)."""

import json
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

from app.auth import signup, whatsapp
from app.config import get_settings
from app.db import get_db

router = APIRouter(prefix="/integrations/whatsapp", tags=["integrations"])


@router.get("/webhook", response_class=PlainTextResponse)
def subscribe(
    mode: str = Query("", alias="hub.mode"),
    token: str = Query("", alias="hub.verify_token"),
    challenge: str = Query("", alias="hub.challenge"),
) -> str:
    """Meta's one-time check when the webhook URL is saved."""
    expected = get_settings().whatsapp_verify_token
    if mode != "subscribe" or not expected or token != expected:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Verification failed")
    return challenge


@router.post("/webhook")
async def incoming(
    request: Request,
    x_hub_signature_256: str | None = Header(None),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    body = await request.body()
    if not whatsapp.valid_signature(body, x_hub_signature_256):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Bad signature")
    try:
        payload = json.loads(body)
    except ValueError:
        return {"ok": True, "confirmed": 0}
    confirmed = [sender for sender, text in whatsapp.text_messages(payload) if signup.confirm_whatsapp(db, sender, text)]
    db.commit()
    for sender in confirmed:
        whatsapp.reply(sender, "Your number is verified. Go back to the OncoReady page to continue.")
    return {"ok": True, "confirmed": len(confirmed)}  # always 200 for a signed call, or Meta retries
