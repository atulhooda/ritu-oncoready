import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, EmailStr
from sqlalchemy.orm import Session

from app.auth.deps import CurrentUser, get_current_user
from app.auth.security import create_access_token, verify_password
from app.db import get_db
from app.repositories.orgs import OrgRepository
from app.repositories.users import UserRepository

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    org_slug: str
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    email: str
    full_name: str
    role: str


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_db)) -> TokenOut:
    invalid = HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    org = OrgRepository(db).get_by_slug(body.org_slug)
    if org is None:
        raise invalid
    user = UserRepository(db, org.id).get_by_email(body.email)
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        raise invalid
    return TokenOut(access_token=create_access_token(user.id, org.id, user.role))


@router.get("/me", response_model=UserOut)
def me(current: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    return UserRepository(db, current.org_id).get(current.id)
