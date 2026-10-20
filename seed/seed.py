"""Load synthetic cases into a demo org. Synthetic data only.

    cd backend && DATABASE_URL=... .venv/bin/python ../seed/seed.py
    docker compose exec backend python /seed/seed.py
"""

import json
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
for candidate in (HERE.parent / "backend", Path("/app")):
    if (candidate / "app").is_dir():
        sys.path.insert(0, str(candidate))
        break

from app.db import SessionLocal  # noqa: E402
from app.models import Role  # noqa: E402
from app.repositories.cases import CaseRepository, DocumentPageRepository, SourceDocumentRepository  # noqa: E402
from app.repositories.orgs import OrgRepository  # noqa: E402
from app.repositories.scoring import AnswerKeyRepository, RubricItemRepository  # noqa: E402
from app.repositories.timeline import (  # noqa: E402
    DiscrepancyRepository,
    PendingTestRepository,
    TimelineEventRepository,
)
from app.repositories.users import UserRepository  # noqa: E402

DEMO_PASSWORD = "synthetic-demo-pass"


def load_case(db, org_id, faculty_id, data: dict) -> None:
    cases = CaseRepository(db, org_id)
    if cases.list(cases.model.case_code == data["case_code"]):
        print(f"  {data['case_code']} already present, skipping")
        return
    case = cases.add(
        case_code=data["case_code"], title=data["title"], summary=data["summary"],
        status="published", created_by_user_id=faculty_id,
    )
    pages: list[list] = []
    for d in data["documents"]:
        doc = SourceDocumentRepository(db, org_id).add(
            case_id=case.id, filename=d["filename"], mime_type="application/pdf",
            storage_key=f"seed/{data['case_code']}/{d['filename']}", page_count=len(d["pages"]),
            uploaded_by_user_id=faculty_id,
        )
        pages.append([
            DocumentPageRepository(db, org_id).add(document_id=doc.id, page_number=i, ocr_text=t, confidence=1.0)
            for i, t in enumerate(d["pages"], start=1)
        ])

    events = [
        TimelineEventRepository(db, org_id).add(
            case_id=case.id, event_date=date.fromisoformat(e["date"]), category=e["category"],
            source_page_id=pages[e["doc"]][e["page"] - 1].id, source_text_span=e["span"], extracted_by="seed",
        )
        for e in data["timeline"]
    ]
    for t in data["pending_tests"]:
        PendingTestRepository(db, org_id).add(
            case_id=case.id, test_name=t["test_name"], source_page_id=pages[t["doc"]][t["page"] - 1].id,
            source_text_span=t["span"], extracted_by="seed",
        )
    for x in data["discrepancies"]:
        a, b = x["events"]
        DiscrepancyRepository(db, org_id).add(
            case_id=case.id, event_a_id=events[a].id, event_b_id=events[b].id,
            field=x["field"], description=x["description"],
        )

    key = AnswerKeyRepository(db, org_id).add(case_id=case.id, status="final", authored_by_user_id=faculty_id)
    for pos, item in enumerate(data["rubric"]):
        RubricItemRepository(db, org_id).add(answer_key_id=key.id, position=pos, **item)
    print(f"  loaded {data['case_code']}")


def main() -> None:
    with SessionLocal() as db:
        orgs = OrgRepository(db)
        org = orgs.get_by_slug("demo") or orgs.create(name="Demo Teaching Hospital (synthetic)", slug="demo")
        users = UserRepository(db, org.id)
        for role in Role:
            email = f"{role.value}@demo.example.com"
            if users.get_by_email(email) is None:
                users.create(email, f"Demo {role.value.title()}", DEMO_PASSWORD, role)
        faculty = users.get_by_email("faculty@demo.example.com")
        print(f"org 'demo' — users <role>@demo.example.com / {DEMO_PASSWORD}")
        for path in sorted((HERE / "cases").glob("*.json")):
            load_case(db, org.id, faculty.id, json.loads(path.read_text()))
        db.commit()


if __name__ == "__main__":
    main()
