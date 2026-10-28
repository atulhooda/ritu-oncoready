"""Load the synthetic cases into a demo org and run the document pipeline on their PDFs.

    cd backend && DATABASE_URL=... .venv/bin/python ../seed/seed.py [--sync] [--reprocess]
    docker compose exec backend python /seed/seed.py              # enqueue to the worker

Documents are the rendered PDFs in seed/cases/<code>/docs (see render.py). Answer keys become
answer_keys + rubric_items. Timeline facts are NOT inserted directly: the pipeline extracts them.
"""

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
for candidate in (HERE.parent / "backend", Path("/app")):
    if (candidate / "app").is_dir():
        sys.path.insert(0, str(candidate))
        break

from app import storage  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import Role  # noqa: E402
from app.repositories.cases import CaseRepository, SourceDocumentRepository  # noqa: E402
from app.repositories.orgs import OrgRepository  # noqa: E402
from app.repositories.scoring import AnswerKeyRepository, RubricItemRepository  # noqa: E402
from app.repositories.users import UserRepository  # noqa: E402

DEMO_PASSWORD = "synthetic-demo-pass"


def load_case(db, org, faculty_id, case_dir: Path) -> list[tuple]:
    """Create the case, its documents, and its answer key. Returns (doc_id, case_id) to process."""
    data = json.loads((case_dir / "case.json").read_text())
    key = json.loads((case_dir / "answer_key.json").read_text())
    cases = CaseRepository(db, org.id)
    existing = cases.list(cases.model.case_code == data["case_code"])
    if existing:
        print(f"  {data['case_code']} already present")
        return [(d.id, d.case_id) for d in SourceDocumentRepository(db, org.id).for_case(existing[0].id)]

    case = cases.add(
        case_code=data["case_code"], title=data["title"], summary=data["summary"],
        status="published", created_by_user_id=faculty_id,
    )
    todo = []
    for d in data["documents"]:
        storage_key = f"{org.slug}/{data['case_code']}/{d['filename']}"
        storage.write_bytes(storage_key, (case_dir / "docs" / d["filename"]).read_bytes())
        doc = SourceDocumentRepository(db, org.id).add(
            case_id=case.id, filename=d["filename"], mime_type="application/pdf",
            storage_key=storage_key, uploaded_by_user_id=faculty_id,
        )
        todo.append((doc.id, case.id))

    answer_key = AnswerKeyRepository(db, org.id).add(case_id=case.id, status="final", authored_by_user_id=faculty_id)
    for pos, item in enumerate(key["rubric"]):
        RubricItemRepository(db, org.id).add(answer_key_id=answer_key.id, position=pos, **item)
    print(f"  loaded {data['case_code']} ({len(todo)} documents)")
    return todo


def load_intake_personas(sync: bool) -> None:
    """Doctor user + demo patients. Personas with a transcript get a finished session (stored
    through the same path as a Ritu callback), their records, and are sent to the doctor."""
    import uuid as uuid_mod

    from app.intake import service
    from app.intake.extraction import run_intake_extraction
    from app.repositories.intake import IntakeSessionRepository

    to_process = []
    with SessionLocal() as db:
        org = OrgRepository(db).get_by_slug("demo")
        users = UserRepository(db, org.id)
        if users.get_by_email("doctor@demo.example.com") is None:
            users.create("doctor@demo.example.com", "Dr. Demo Oncologist", DEMO_PASSWORD, Role.DOCTOR)
        for path in sorted((HERE / "personas").glob("*.json")):
            p = json.loads(path.read_text())
            user = users.get_by_email(p["email"]) or users.create(p["email"], p["name"], DEMO_PASSWORD, Role.PATIENT)
            case = service.profile_case(db, user)
            if p.get("details"):  # always refreshed, so existing personas pick up new fields
                from datetime import date

                service.update_details(db, user, {
                    k: date.fromisoformat(v) if k in ("date_of_birth", "diagnosed_on") and v else v
                    for k, v in p["details"].items()
                })
            # Records are added by filename, so existing personas pick up new ones.
            have = {d.filename for d in SourceDocumentRepository(db, org.id).for_case(case.id)}
            for rel in p["records"]:
                src = HERE / rel if rel.startswith("personas/") else HERE / "cases" / rel
                if src.name in have:
                    continue
                doc_id = uuid_mod.uuid4()
                key = f"{org.id}/{case.id}/{doc_id}.pdf"
                storage.write_bytes(key, src.read_bytes())
                SourceDocumentRepository(db, org.id).add(
                    id=doc_id, case_id=case.id, filename=src.name, mime_type="application/pdf",
                    storage_key=key, uploaded_by_user_id=user.id,
                )
                to_process.append((doc_id, case.id))
                print(f"  {p['name']}: added record {src.name}")
            if IntakeSessionRepository(db, org.id).for_case(case.id):
                print(f"  {p['name']}: already has a session")
                continue
            if p["transcript"]:
                session, _ = service.start_session(db, user)
                service.record_transcript(db, org.id, session, p["transcript"])
                print(f"  {p['name']}: summary {run_intake_extraction(db, org.id, session.id)}")
                if p["publish"]:
                    service.publish(db, user)
            print(f"  {p['name']}: {p['email']} / {DEMO_PASSWORD}, {len(p['records'])} record(s)")
        db.commit()
        org_id = org.id
    print(f"doctor: doctor@demo.example.com / {DEMO_PASSWORD}")
    for doc_id, case_id in to_process:
        if sync:
            from app.pipeline.derive import run_derive
            from app.pipeline.extraction import run_extraction
            from app.pipeline.ocr import run_ocr

            with SessionLocal() as db:
                run_ocr(db, org_id, doc_id)
                run_extraction(db, org_id, doc_id)
                run_derive(db, org_id, case_id)
                db.commit()
        else:
            from app.pipeline.tasks import enqueue_document

            enqueue_document(org_id, doc_id, case_id)
    if to_process and not sync:
        print(f"enqueued {len(to_process)} record(s) for OCR + extraction")


def submit_demo_briefs(sync: bool) -> None:
    from datetime import UTC, datetime

    from app.repositories.scoring import ReadinessBriefRepository
    from app.scoring.matching import SECTIONS

    with SessionLocal() as db:
        org = OrgRepository(db).get_by_slug("demo")
        resident = UserRepository(db, org.id).get_by_email("resident@demo.example.com")
        cases = CaseRepository(db, org.id)
        briefs = ReadinessBriefRepository(db, org.id)
        todo = []
        for path in sorted((HERE / "briefs").glob("*.json")):
            data = json.loads(path.read_text())
            case = cases.list(cases.model.case_code == path.stem)[0]
            if briefs.get_for(case.id, resident.id):
                print(f"  {path.stem}: brief already exists")
                continue
            brief = briefs.add(
                case_id=case.id, author_user_id=resident.id, content={k: data[k] for k in SECTIONS},
                status="submitted", submitted_at=datetime.now(UTC),
            )
            todo.append(brief.id)
            print(f"  {path.stem}: submitted demo brief")
        db.commit()
        org_id = org.id
    for brief_id in todo:
        if sync:
            from app.scoring.service import match_and_score

            with SessionLocal() as db:
                s = match_and_score(db, org_id, brief_id)
                db.commit()
                print(f"  scored {brief_id}: {s.details['percent']}% critical_missed={s.critical_missed}")
        else:
            from app.scoring.tasks import enqueue_scoring

            enqueue_scoring(org_id, brief_id)
    if todo and not sync:
        print(f"enqueued scoring for {len(todo)} brief(s)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sync", action="store_true", help="run the pipeline in this process instead of Celery")
    ap.add_argument("--reprocess", action="store_true", help="re-run the pipeline for documents already loaded")
    ap.add_argument("--demo-briefs", action="store_true",
                    help="submit seed/briefs/*.json as the demo resident and score them (needs an LLM key)")
    ap.add_argument("--intake", action="store_true",
                    help="create the doctor + patient personas in seed/personas (needs an LLM key for summaries)")
    args = ap.parse_args()
    if args.demo_briefs:
        submit_demo_briefs(sync=args.sync)
        return
    if args.intake:
        load_intake_personas(sync=args.sync)
        return

    with SessionLocal() as db:
        orgs = OrgRepository(db)
        org = orgs.get_by_slug("demo") or orgs.create(name="Demo Teaching Hospital (synthetic)", slug="demo")
        org.join_code, org.patient_signup_open = "DEMO", True  # patients can sign up at /join/DEMO
        users = UserRepository(db, org.id)
        for role in Role:
            email = f"{role.value}@demo.example.com"
            if users.get_by_email(email) is None:
                users.create(email, f"Demo {role.value.title()}", DEMO_PASSWORD, role)
        faculty = users.get_by_email("faculty@demo.example.com")
        print(f"org 'demo' - users <role>@demo.example.com / {DEMO_PASSWORD}")

        todo = []
        for case_dir in sorted(p for p in (HERE / "cases").iterdir() if (p / "case.json").exists()):
            docs = load_case(db, org, faculty.id, case_dir)
            fresh = [d for d in docs if SourceDocumentRepository(db, org.id).get(d[0]).status == "uploaded"]
            todo += docs if args.reprocess else fresh
        db.commit()
        org_id = org.id

    if not todo:
        print("nothing to process (use --reprocess to run again)")
        return
    if args.sync:
        from app.pipeline.derive import run_derive
        from app.pipeline.extraction import run_extraction
        from app.pipeline.ocr import run_ocr

        for doc_id, case_id in todo:
            with SessionLocal() as db:
                try:
                    print(f"  ocr {doc_id}: {run_ocr(db, org_id, doc_id)} page(s)")
                    db.commit()
                    print(f"  extract {doc_id}: {run_extraction(db, org_id, doc_id)}")
                    db.commit()
                except Exception as e:
                    db.rollback()
                    doc = SourceDocumentRepository(db, org_id).get(doc_id)
                    doc.status, doc.error = "failed", f"{type(e).__name__}: {e}"[:2000]
                    db.commit()
                    print(f"  FAILED {doc_id}: {doc.error}")
        with SessionLocal() as db:
            for case_id in sorted({c for _, c in todo}):
                print(f"  derive {case_id}: {run_derive(db, org_id, case_id)}")
            db.commit()
    else:
        from app.pipeline.tasks import enqueue_document

        for doc_id, case_id in todo:
            enqueue_document(org_id, doc_id, case_id)
        print(f"enqueued {len(todo)} document(s); watch: docker compose logs -f worker")


if __name__ == "__main__":
    main()
