from app.auth.security import hash_password
import uuid

from app.models import PractitionerProfile, Role, User
from app.repositories.base import TenantRepository


class UserRepository(TenantRepository[User]):
    model = User

    def get_by_email(self, email: str) -> User | None:
        return self.session.scalar(self.select().where(User.email == email.lower()))

    def create(self, email: str, full_name: str, password: str, role: Role) -> User:
        return self.add(
            email=email.lower(), full_name=full_name, password_hash=hash_password(password), role=role.value
        )


class PractitionerProfileRepository(TenantRepository[PractitionerProfile]):
    model = PractitionerProfile

    def get_for(self, user_id: uuid.UUID) -> PractitionerProfile | None:
        return self.session.scalar(self.select().where(PractitionerProfile.user_id == user_id))
