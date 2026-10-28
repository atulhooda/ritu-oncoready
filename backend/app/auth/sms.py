"""The only module that sends SMS. MSG91 when configured; otherwise demo mode, where nothing is
sent and the caller shows the code on screen (labelled), for test accounts only."""

import httpx

from app.config import get_settings


class SmsError(RuntimeError):
    pass


def enabled() -> bool:
    s = get_settings()
    return bool(s.msg91_auth_key and s.msg91_template_id)


def send_otp(phone: str, code: str) -> None:
    """phone in E.164 (+91...). MSG91 OTP API v5: the code is ours; MSG91 fills its DLT template."""
    s = get_settings()
    try:
        r = httpx.post(
            "https://control.msg91.com/api/v5/otp",
            params={"template_id": s.msg91_template_id, "mobile": phone.lstrip("+"), "otp": code},
            headers={"authkey": s.msg91_auth_key},
            timeout=15,
        )
        r.raise_for_status()
        if (r.json() or {}).get("type") == "error":
            raise SmsError(r.json().get("message") or "MSG91 refused the message")
    except (httpx.HTTPError, ValueError) as e:
        raise SmsError(f"could not send the code: {e}") from e
