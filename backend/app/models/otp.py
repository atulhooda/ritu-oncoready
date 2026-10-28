import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args



class PhoneOtp(TenantMixin, Base):
    """A one-time code sent to a phone, for one clinic. Only a keyed hash of the code is stored."""

    __tablename__ = "phone_otps"
    __table_args__ = tenant_args(
        CheckConstraint("purpose = 'join'", name="purpose"),  # one code covers sign-up and sign-in
        CheckConstraint("attempts >= 0", name="attempts_nonnegative"),
    )

    phone: Mapped[str] = mapped_column(String(16), index=True)
    purpose: Mapped[str] = mapped_column(String(16), server_default="join")
    code_hash: Mapped[str] = mapped_column(String(64))
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
