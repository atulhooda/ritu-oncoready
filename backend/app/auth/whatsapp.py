"""WhatsApp (Meta Cloud API) for verifying patients' numbers for free: the patient messages us, so
no paid template is sent. Webhook calls are checked with the app secret (X-Hub-Signature-256)."""

import hashlib
import hmac
import logging

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)


def enabled() -> bool:
    s = get_settings()
    return bool(s.whatsapp_number and s.whatsapp_app_secret)


def link(message: str) -> str:
    """wa.me link that opens a chat with the clinic number, the message typed in."""
    from urllib.parse import quote

    return f"https://wa.me/{get_settings().whatsapp_number.lstrip('+')}?text={quote(message)}"


def valid_signature(body: bytes, header: str | None) -> bool:
    secret = get_settings().whatsapp_app_secret
    if not secret or not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header.removeprefix("sha256="))


def text_messages(payload: dict) -> list[tuple[str, str]]:
    """(sender, text) for every text message in a webhook payload."""
    out = []
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            for msg in (change.get("value") or {}).get("messages") or []:
                if msg.get("type") == "text" and msg.get("from"):
                    out.append((msg["from"], (msg.get("text") or {}).get("body") or ""))
    return out


def reply(to: str, text: str) -> None:
    """Best effort, free inside the 24-hour window the patient's own message opened."""
    s = get_settings()
    if not (s.whatsapp_access_token and s.whatsapp_phone_number_id):
        return
    try:
        httpx.post(
            f"https://graph.facebook.com/{s.whatsapp_graph_version}/{s.whatsapp_phone_number_id}/messages",
            json={"messaging_product": "whatsapp", "to": to.lstrip("+"), "type": "text", "text": {"body": text}},
            headers={"Authorization": f"Bearer {s.whatsapp_access_token}"},
            timeout=10,
        ).raise_for_status()
    except httpx.HTTPError as e:
        log.warning("whatsapp reply failed: %s", e)
