import uuid
from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.auth.security import decode_access_token
from app.db import get_db
from app.models import Role
from app.repositories.users import UserRepository

bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class CurrentUser:
    id: uuid.UUID
    org_id: uuid.UUID
    role: Role


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> CurrentUser:
    unauthorized = HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    if creds is None:
        raise unauthorized
    try:
        claims = decode_access_token(creds.credentials)
        user_id, org_id = uuid.UUID(claims["sub"]), uuid.UUID(claims["org_id"])
    except (jwt.PyJWTError, ValueError):
        raise unauthorized
    # Re-check the user still exists and is active *within the token's org*.
    user = UserRepository(db, org_id).get(user_id)
    if user is None or not user.is_active:
        raise unauthorized
    return CurrentUser(id=user.id, org_id=user.org_id, role=Role(user.role))


def require_role(*roles: Role):
    def check(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient role")
        return user

    return check


def ensure_case_unlocked(db: Session, user: CurrentUser, case_id: uuid.UUID) -> None:
    """Residents see AI-derived case data (timeline, OCR text) only after submitting their brief."""
    from app.repositories.scoring import ReadinessBriefRepository

    if user.role == Role.RESIDENT and not ReadinessBriefRepository(db, user.org_id).has_submitted(case_id, user.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Submit your readiness brief to unlock this")
