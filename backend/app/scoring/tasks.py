import uuid

from app.db import SessionLocal
from app.repositories.scoring import ReadinessBriefRepository
from app.scoring.service import match_and_score
from app.worker import celery_app


@celery_app.task(name="scoring.match_and_score")
def match_and_score_task(org_id: str, brief_id: str) -> dict:
    org, brief_id_ = uuid.UUID(org_id), uuid.UUID(brief_id)
    try:
        with SessionLocal() as db:
            s = match_and_score(db, org, brief_id_)
            db.commit()
            return {"points_earned": str(s.points_earned), "critical_missed": s.critical_missed}
    except Exception as e:
        with SessionLocal() as db:
            brief = ReadinessBriefRepository(db, org).get(brief_id_)
            if brief is not None:
                brief.status = "scoring_failed"
                brief.scoring_error = f"{type(e).__name__}: {e}"[:2000]
                db.commit()
        raise


def enqueue_scoring(org_id: uuid.UUID, brief_id: uuid.UUID) -> None:
    match_and_score_task.delay(str(org_id), str(brief_id))
