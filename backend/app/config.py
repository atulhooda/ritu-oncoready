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

    # Patient sign-up by phone (app/auth/signup.py). Without an MSG91 key, codes are not sent: the
    # API returns them so the page can show them, labelled demo. Never leave it like that with real patients.
    msg91_auth_key: str = ""
    msg91_template_id: str = ""
    # Free alternative to SMS: the patient sends "JOIN <clinic> <code>" from their own WhatsApp to this
    # number; Meta's signed webhook (POST /integrations/whatsapp/webhook) proves the sender's number.
    whatsapp_number: str = ""  # the business number patients message, E.164, e.g. +919876543210
    whatsapp_app_secret: str = ""  # Meta app secret: checks X-Hub-Signature-256 on webhook calls
    whatsapp_verify_token: str = ""  # any string; the same one goes in Meta's webhook settings
    whatsapp_access_token: str = ""  # optional: send a free "verified" reply (24-hour service window)
    whatsapp_phone_number_id: str = ""
    whatsapp_graph_version: str = "v21.0"
    otp_ttl_seconds: int = 300
    otp_max_per_hour: int = 5
    otp_max_attempts: int = 5
    # The one switch for real (non-synthetic) people: CLAUDE.md rule 2. Live DigiLocker needs it.
    real_patient_data: bool = False

    # DigiLocker (app/identity/digilocker.py). Partner credentials from API Setu / DigiLocker;
    # the redirect URI is the frontend's /patient/digilocker page and must match the registration.
    digilocker_client_id: str = ""
    digilocker_client_secret: str = ""
    digilocker_redirect_uri: str = ""
    digilocker_base_url: str = "https://digilocker.meripehchaan.gov.in/public/oauth2"
    seed_dir: str = "/seed"  # synthetic PDFs used as DigiLocker documents in demo mode

    # LLM (extraction only, see app/llm/client.py)
    gemini_api_key: str | None = None
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
