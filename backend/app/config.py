from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/oncoready"
    redis_url: str = "redis://localhost:6379/0"
    cors_origins: str = "http://localhost:3000"  # comma-separated

    jwt_secret: str = "dev-only-insecure-secret-change-me-0123456789"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60

    # Uploaded PDFs and rendered page images (shared by backend and worker)
    storage_dir: str = "./.storage"

    # Document pipeline
    ocr_engines: str = "paddleocr,tesseract"  # tried in order; later ones are fallbacks
    ocr_dpi: int = 200
    span_match_threshold: float = 0.85  # rapidfuzz partial ratio, 0..1

    # Ritu voice server (docs/VOICE_INTEGRATION.md). Empty base URL -> typed simulator mode.
    ritu_base_url: str = ""
    ritu_shared_secret: str = ""  # HMAC for requests to Ritu and for Ritu's callbacks
    public_api_url: str = "http://localhost:8000"  # where Ritu sends the session callback
    clinic_display_name: str = "OncoReady demo clinic"

    # LLM (extraction only, see app/llm/client.py)
    gemini_api_key: str | None = None
    gemini_model: str = "gemini-2.5-flash"
    groq_api_key: str | None = None
    groq_model: str = "llama-3.3-70b-versatile"


@lru_cache
def get_settings() -> Settings:
    return Settings()
