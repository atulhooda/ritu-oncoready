from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import auth, cases, documents
from app.config import get_settings

app = FastAPI(title="Ritu OncoReady")
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth.router)
app.include_router(cases.router)
app.include_router(documents.router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
