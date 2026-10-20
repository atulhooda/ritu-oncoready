"""PDF -> page images -> text + confidence. PaddleOCR first, Tesseract as fallback."""

import logging
import os
import uuid
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from statistics import median

import pymupdf
from PIL import Image
from sqlalchemy.orm import Session

from app import storage
from app.config import get_settings
from app.repositories.cases import DocumentPageRepository, SourceDocumentRepository

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class OcrResult:
    text: str
    confidence: float  # 0..1
    engine: str


def rasterize(pdf_path: Path, dpi: int) -> list[Image.Image]:
    with pymupdf.open(pdf_path) as doc:
        images = []
        for page in doc:
            pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
            images.append(Image.frombytes("L", (pix.width, pix.height), pix.samples))
        return images


@lru_cache(maxsize=1)
def _paddle():
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    from paddleocr import PaddleOCR

    return PaddleOCR(
        lang="en",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="en_PP-OCRv5_mobile_rec",
    )


def _group_lines(items: list[tuple[str, float, list[float]]]) -> str:
    """Paddle returns text boxes; rebuild reading-order lines (boxes with overlapping y-centers)."""
    if not items:
        return ""
    tol = median(b[3] - b[1] for _, _, b in items) / 2
    lines: list[list[tuple[str, float, list[float]]]] = []
    for item in sorted(items, key=lambda it: (it[2][1] + it[2][3]) / 2):
        yc = (item[2][1] + item[2][3]) / 2
        if lines and abs(yc - sum((b[1] + b[3]) / 2 for _, _, b in lines[-1]) / len(lines[-1])) <= tol:
            lines[-1].append(item)
        else:
            lines.append([item])
    return "\n".join(" ".join(t for t, _, _ in sorted(line, key=lambda it: it[2][0])) for line in lines)


def ocr_paddle(img: Image.Image) -> OcrResult:
    import numpy as np

    r = _paddle().predict(np.array(img.convert("RGB")))[0]
    items = [(t, float(s), list(map(float, b))) for t, s, b in zip(r["rec_texts"], r["rec_scores"], r["rec_boxes"])]
    chars = sum(len(t) for t, _, _ in items)
    conf = sum(s * len(t) for t, s, _ in items) / chars if chars else 0.0
    return OcrResult(_group_lines(items), conf, "paddleocr")


def ocr_tesseract(img: Image.Image) -> OcrResult:
    import pytesseract

    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
    confs = [float(c) for c, w in zip(data["conf"], data["text"]) if float(c) >= 0 and w.strip()]
    text = pytesseract.image_to_string(img).strip()
    return OcrResult(text, (sum(confs) / len(confs) / 100) if confs else 0.0, "tesseract")


ENGINES = {"paddleocr": ocr_paddle, "tesseract": ocr_tesseract}


def ocr_image(img: Image.Image) -> OcrResult:
    errors = []
    for name in get_settings().ocr_engines.split(","):
        try:
            result = ENGINES[name.strip()](img)
            if result.text.strip():
                return result
            errors.append(f"{name}: no text")
        except Exception as e:  # engine missing or crashed -> next engine
            log.warning("OCR engine %s failed: %s", name, e)
            errors.append(f"{name}: {e}")
    raise RuntimeError("all OCR engines failed: " + "; ".join(errors))


def run_ocr(db: Session, org_id: uuid.UUID, document_id: uuid.UUID) -> int:
    """OCR every page of a document, replacing any previous pages. Returns page count."""
    doc = SourceDocumentRepository(db, org_id).get(document_id)
    if doc is None:
        raise LookupError("document not found")
    pages = DocumentPageRepository(db, org_id)
    pages.delete_where(pages.model.document_id == doc.id)  # cascades to facts from old pages

    images = rasterize(storage.path(doc.storage_key), get_settings().ocr_dpi)
    for n, img in enumerate(images, start=1):
        key = storage.page_image_key(doc.storage_key, n)
        storage.path(key).parent.mkdir(parents=True, exist_ok=True)
        img.save(storage.path(key))
        result = ocr_image(img)
        pages.add(
            document_id=doc.id, page_number=n, ocr_text=result.text,
            confidence=round(result.confidence, 4), ocr_engine=result.engine,
        )
    doc.page_count = len(images)
    doc.status = "ocr_done"
    doc.error = None
    db.flush()
    return len(images)
