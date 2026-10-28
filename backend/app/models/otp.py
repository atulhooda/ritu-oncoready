import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args



class PhoneOtp(TenantMixin, Base):
    """A one-time code for one phone at one clinic. Only a keyed hash of the code is stored.

    sms: we send the code, the patient types it in.
    whatsapp: the patient sends the code from their own WhatsApp; Meta's signed webhook proves the
    sender's number, which sets confirmed_at; the page that started it then signs the patient in.
    """

    __tablename__ = "phone_otps"
    __table_args__ = tenant_args(
        CheckConstraint("purpose = 'join'", name="purpose"),  # one code covers sign-up and sign-in
        CheckConstraint("attempts >= 0", name="attempts_nonnegative"),
        CheckConstraint("channel IN ('sms', 'whatsapp')", name="channel"),
        CheckConstraint("confirmed_at IS NULL OR channel = 'whatsapp'", name="confirmed_only_whatsapp"),
    )

    phone: Mapped[str] = mapped_column(String(16), index=True)
    purpose: Mapped[str] = mapped_column(String(16), server_default="join")
    code_hash: Mapped[str] = mapped_column(String(64))
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    channel: Mapped[str] = mapped_column(String(16), server_default="sms")
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
