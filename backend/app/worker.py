from celery import Celery

from app.config import get_settings

settings = get_settings()
celery_app = Celery(
    "oncoready",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.pipeline.tasks", "app.scoring.tasks"],
)
celery_app.conf.update(task_acks_late=True, worker_prefetch_multiplier=1)


@celery_app.task
def ping() -> str:
    return "pong"
