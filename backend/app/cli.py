"""Admin commands.

    python -m app.cli create-clinic --name "City Cancer Centre" --code CCC \\
        --hospital-email admin@example.com --hospital-name "City Cancer Centre" --hospital-password '...'
    python -m app.cli bootstrap      # the same, from BOOTSTRAP_* environment variables (Railway)

The hospital account then adds its doctors (junior / senior) in the app. Both are safe to repeat:
an existing clinic (by code) or account (by email) is left as it is, apart from opening patient
sign-up and turning an older single "doctor" login with that email into the hospital account.
"""

import argparse
import os
import re
import sys

from app.db import SessionLocal
from app.models import Role
from app.repositories.orgs import OrgRepository
from app.repositories.users import UserRepository


def create_clinic(name: str, code: str, email: str | None, account_name: str | None, password: str | None) -> None:
    code = code.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{3,16}", code):
        sys.exit("The clinic code must be 3-16 letters or digits, e.g. CCC")
    with SessionLocal() as db:
        orgs = OrgRepository(db)
        org = orgs.get_by_join_code(code)
        if org is None:
            org = orgs.create(name=name, slug=code.lower())
            org.join_code = code
            print(f"clinic created: {name} (code {code})")
        else:
            print(f"clinic exists: {org.name} (code {code})")
        org.patient_signup_open = True
        db.commit()  # the clinic stands even if the account below cannot be created
        if email:
            users = UserRepository(db, org.id)
            existing = users.get_by_email(email)
            if existing is not None:
                if existing.role == Role.DOCTOR.value:  # the login from before hospitals had doctors
                    existing.role, existing.seniority = Role.HOSPITAL.value, None
                    db.commit()
                    print(f"hospital account (was the doctor login): {email}")
                else:
                    print(f"account exists: {email}")
            elif not password or len(password) < 10:
                sys.exit(f"hospital account NOT created: {email} needs a password of at least 10 characters")
            else:
                users.create(email, account_name or name, password, Role.HOSPITAL)
                db.commit()
                print(f"hospital account created: {email} (clinic code {code})")


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m app.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-clinic")
    c.add_argument("--name", required=True)
    c.add_argument("--code", required=True)
    c.add_argument("--hospital-email")
    c.add_argument("--hospital-name")
    c.add_argument("--hospital-password")
    sub.add_parser("bootstrap")
    args = ap.parse_args()
    if args.cmd == "create-clinic":
        create_clinic(args.name, args.code, args.hospital_email, args.hospital_name, args.hospital_password)
    elif os.environ.get("BOOTSTRAP_CLINIC_CODE"):
        env = lambda key: os.environ.get(f"BOOTSTRAP_HOSPITAL_{key}") or os.environ.get(f"BOOTSTRAP_DOCTOR_{key}")  # noqa: E731
        create_clinic(
            os.environ.get("BOOTSTRAP_CLINIC_NAME") or os.environ["BOOTSTRAP_CLINIC_CODE"],
            os.environ["BOOTSTRAP_CLINIC_CODE"],
            env("EMAIL"), env("NAME"), env("PASSWORD"),
        )


if __name__ == "__main__":
    main()
