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
    args = ap.parse_args()
    if args.demo_briefs:
        submit_demo_briefs(sync=args.sync)
        return

    with SessionLocal() as db:
        orgs = OrgRepository(db)
        org = orgs.get_by_slug("demo") or orgs.create(name="Demo Teaching Hospital (synthetic)", slug="demo")
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
