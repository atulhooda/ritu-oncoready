"""Admin commands.

    python -m app.cli create-clinic --name "City Cancer Centre" --code CCC \\
        --doctor-email dr.rao@example.com --doctor-name "Dr. Rao" --doctor-password '...'
    python -m app.cli bootstrap      # the same, from BOOTSTRAP_* environment variables (Railway)

Both are safe to repeat: an existing clinic (by code) or doctor (by email) is left as it is, apart
from opening patient sign-up.
"""

import argparse
import os
import re
import sys

from app.db import SessionLocal
from app.models import Role
from app.repositories.orgs import OrgRepository
from app.repositories.users import UserRepository


def create_clinic(name: str, code: str, doctor_email: str | None, doctor_name: str | None, doctor_password: str | None) -> None:
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
        if doctor_email:
            users = UserRepository(db, org.id)
            if users.get_by_email(doctor_email) is None:
                if not doctor_password or len(doctor_password) < 10:
                    sys.exit("Give the doctor a password of at least 10 characters")
                users.create(doctor_email, doctor_name or "Doctor", doctor_password, Role.DOCTOR)
                print(f"doctor created: {doctor_email} (organization '{org.slug}')")
            else:
                print(f"doctor exists: {doctor_email}")
        db.commit()


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m app.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-clinic")
    c.add_argument("--name", required=True)
    c.add_argument("--code", required=True)
    c.add_argument("--doctor-email")
    c.add_argument("--doctor-name")
    c.add_argument("--doctor-password")
    sub.add_parser("bootstrap")
    args = ap.parse_args()
    if args.cmd == "create-clinic":
        create_clinic(args.name, args.code, args.doctor_email, args.doctor_name, args.doctor_password)
    elif os.environ.get("BOOTSTRAP_CLINIC_CODE"):
        create_clinic(
            os.environ.get("BOOTSTRAP_CLINIC_NAME") or os.environ["BOOTSTRAP_CLINIC_CODE"],
            os.environ["BOOTSTRAP_CLINIC_CODE"],
            os.environ.get("BOOTSTRAP_DOCTOR_EMAIL"),
            os.environ.get("BOOTSTRAP_DOCTOR_NAME"),
            os.environ.get("BOOTSTRAP_DOCTOR_PASSWORD"),
        )


if __name__ == "__main__":
    main()
