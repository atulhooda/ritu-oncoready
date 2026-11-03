from functools import lru_cache

from pydantic import field_validator
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
    clinic_timezone: str = "Asia/Kolkata"  # "yesterday" / "three months ago" in the records assistant
    # Ritu's voice for browser sessions. Calmer than the phone deploy's default (suhani at 1.2x):
    # roopa measured lower and softer in an audition of Sarvam's bulbul:v3 voices (2026-10-22).
    ritu_voice_speaker: str = "roopa"
    ritu_voice_pace: float = 1.0
    ritu_voice_temperature: float = 0.45

    # ABDM (ABHA linking). SANDBOX ONLY: app/identity/abdm.py refuses any other host (CLAUDE.md rule 2).
    # Register at https://sandbox.abdm.gov.in for a client id/secret. Empty -> demo verification.
    abdm_client_id: str = ""
    abdm_client_secret: str = ""
    abdm_gateway_url: str = "https://dev.abdm.gov.in"
    abdm_abha_url: str = "https://abhasbx.abdm.gov.in/abha/api"
    abdm_cert_url: str = ""  # default: {abdm_abha_url}/v3/profile/public/certificate
    abdm_cm_id: str = "sbx"

    # Phone check at sign-up: a 6-digit code sent to the patient's WhatsApp as an approved
    # AUTHENTICATION template (app/auth/whatsapp.py). Without these, the phone is saved unverified.
    whatsapp_access_token: str = ""  # permanent system-user token
    whatsapp_phone_number_id: str = ""  # WhatsApp Manager -> API Setup
    whatsapp_otp_template: str = ""  # the authentication template's name
    whatsapp_otp_template_lang: str = "en"
    whatsapp_graph_version: str = "v21.0"
    # The clinic the main page (/) signs patients up to. Empty: the only clinic with sign-up open.
    default_clinic_code: str = ""
    otp_ttl_seconds: int = 300
    otp_max_per_hour: int = 5
    otp_max_attempts: int = 5

    # LLM (extraction only, see app/llm/client.py)
    gemini_api_key: str | None = None
    # Consultation scribe: Sarvam batch speech-to-text (with speaker diarization)
    sarvam_api_key: str | None = None
    sarvam_stt_model: str = "saaras:v3"
    sarvam_stt_language: str = "unknown"  # auto-detect (Hindi, English, mixed ...)
    sarvam_max_wait_seconds: int = 900
    gemini_model: str = "gemini-2.5-flash"
    groq_api_key: str | None = None
    groq_model: str = "llama-3.3-70b-versatile"


    @field_validator("database_url")
    @classmethod
    def psycopg_driver(cls, v: str) -> str:
        """Hosts such as Railway hand out postgres:// or postgresql:// URLs; use the psycopg 3 driver."""
        for prefix in ("postgres://", "postgresql://"):
            if v.startswith(prefix):
                return "postgresql+psycopg://" + v[len(prefix):]
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()
