from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import auth, cases

app = FastAPI(title="Ritu OncoReady")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth.router)
app.include_router(cases.router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
