"""WhatsApp (Meta Cloud API): sends the 6-digit code that proves a patient's phone at sign-up.

The code goes out as an approved AUTHENTICATION template (Meta requires a template for a message
the business starts; it is billed per message). Configure the template in WhatsApp Manager with a
"copy code" button, then set WHATSAPP_OTP_TEMPLATE to its name.
"""

import httpx

from app.config import get_settings


class WhatsAppError(RuntimeError):
    pass


def enabled() -> bool:
    s = get_settings()
    return bool(s.whatsapp_access_token and s.whatsapp_phone_number_id and s.whatsapp_otp_template)


def send_code(phone: str, code: str) -> None:
    """phone in E.164 (+91...)."""
    s = get_settings()
    body = {
        "messaging_product": "whatsapp",
        "to": phone.lstrip("+"),
        "type": "template",
        "template": {
            "name": s.whatsapp_otp_template,
            "language": {"code": s.whatsapp_otp_template_lang},
            "components": [
                {"type": "body", "parameters": [{"type": "text", "text": code}]},
                # authentication templates carry the code in their copy-code button too
                {"type": "button", "sub_type": "url", "index": "0", "parameters": [{"type": "text", "text": code}]},
            ],
        },
    }
    try:
        r = httpx.post(
            f"https://graph.facebook.com/{s.whatsapp_graph_version}/{s.whatsapp_phone_number_id}/messages",
            json=body, headers={"Authorization": f"Bearer {s.whatsapp_access_token}"}, timeout=15,
        )
    except httpx.HTTPError as e:
        raise WhatsAppError(f"could not reach WhatsApp: {e}") from e
    if r.status_code >= 400:
        try:
            detail = r.json().get("error", {}).get("message") or r.text
        except ValueError:
            detail = r.text
        raise WhatsAppError(f"WhatsApp did not send the code: {detail[:200]}")
