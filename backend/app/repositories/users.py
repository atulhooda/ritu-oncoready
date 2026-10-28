from app.auth.security import hash_password
import uuid

from datetime import datetime

from sqlalchemy import func

from app.models import PhoneOtp, PractitionerProfile, Role, User
from app.repositories.base import TenantRepository


class UserRepository(TenantRepository[User]):
    model = User

    def get_by_email(self, email: str) -> User | None:
        return self.session.scalar(self.select().where(User.email == email.lower()))

    def get_by_phone(self, phone: str) -> User | None:
        return self.session.scalar(self.select().where(User.phone == phone))

    def create(self, email: str, full_name: str, password: str, role: Role) -> User:
        return self.add(
            email=email.lower(), full_name=full_name, password_hash=hash_password(password), role=role.value
        )


class PractitionerProfileRepository(TenantRepository[PractitionerProfile]):
    model = PractitionerProfile

    def get_for(self, user_id: uuid.UUID) -> PractitionerProfile | None:
        return self.session.scalar(self.select().where(PractitionerProfile.user_id == user_id))


class PhoneOtpRepository(TenantRepository[PhoneOtp]):
    model = PhoneOtp

    def sent_since(self, phone: str, since: datetime) -> int:
        stmt = self.select().with_only_columns(func.count()).where(PhoneOtp.phone == phone, PhoneOtp.created_at >= since)
        return self.session.scalar(stmt) or 0

    def latest_open(self, phone: str) -> PhoneOtp | None:
        """The newest unused code for this phone (older ones are superseded)."""
        stmt = (self.select().where(PhoneOtp.phone == phone, PhoneOtp.consumed_at.is_(None))
                .order_by(PhoneOtp.created_at.desc()).limit(1))
        return self.session.scalar(stmt)
