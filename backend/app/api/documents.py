import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import storage
from app.auth.deps import CurrentUser, get_current_user
from app.db import get_db
from app.repositories.cases import DocumentPageRepository, SourceDocumentRepository

router = APIRouter(prefix="/documents", tags=["documents"])


class PageOut(BaseModel):
    document_id: uuid.UUID
    filename: str
    page_number: int
    ocr_text: str
    confidence: float | None
    ocr_engine: str | None
    image_url: str


def _page_or_404(db: Session, org_id: uuid.UUID, document_id: uuid.UUID, page_number: int):
    doc = SourceDocumentRepository(db, org_id).get(document_id)
    page = DocumentPageRepository(db, org_id).get_by_number(document_id, page_number) if doc else None
    if page is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Page not found")
    return doc, page


@router.get("/{document_id}/pages/{page_number}", response_model=PageOut)
def get_page(
    document_id: uuid.UUID, page_number: int,
    user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db),
):
    doc, page = _page_or_404(db, user.org_id, document_id, page_number)
    return PageOut(
        document_id=doc.id, filename=doc.filename, page_number=page.page_number, ocr_text=page.ocr_text,
        confidence=page.confidence, ocr_engine=page.ocr_engine,
        image_url=f"/documents/{doc.id}/pages/{page.page_number}/image",
    )


@router.get("/{document_id}/pages/{page_number}/image", response_class=FileResponse)
def get_page_image(
    document_id: uuid.UUID, page_number: int,
    user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db),
):
    doc, page = _page_or_404(db, user.org_id, document_id, page_number)
    path = storage.path(storage.page_image_key(doc.storage_key, page.page_number))
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Page image not rendered")
    return FileResponse(path, media_type="image/png")
