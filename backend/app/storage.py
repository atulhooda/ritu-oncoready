"""Local file storage for uploaded PDFs and rendered page images (synthetic data only)."""

from pathlib import Path

from app.config import get_settings


def root() -> Path:
    return Path(get_settings().storage_dir).resolve()


def path(key: str) -> Path:
    p = (root() / key).resolve()
    if not p.is_relative_to(root()):
        raise ValueError("storage key escapes storage root")
    return p


def write_bytes(key: str, data: bytes) -> Path:
    p = path(key)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return p


def page_image_key(document_storage_key: str, page_number: int) -> str:
    return f"{document_storage_key}.pages/{page_number}.png"
