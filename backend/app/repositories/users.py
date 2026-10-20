from app.auth.security import hash_password
from app.models import Role, User
from app.repositories.base import TenantRepository


class UserRepository(TenantRepository[User]):
    model = User

    def get_by_email(self, email: str) -> User | None:
        return self.session.scalar(self.select().where(User.email == email.lower()))

    def create(self, email: str, full_name: str, password: str, role: Role) -> User:
        return self.add(
            email=email.lower(), full_name=full_name, password_hash=hash_password(password), role=role.value
        )
