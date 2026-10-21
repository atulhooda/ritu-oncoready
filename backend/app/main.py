from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import auth, briefs, cases, doctor, documents, faculty, integrations, patient
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
app.include_router(briefs.router)
app.include_router(faculty.router)
app.include_router(patient.router)
app.include_router(doctor.router)
app.include_router(integrations.router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
