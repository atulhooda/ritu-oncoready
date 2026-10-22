"""Turning what a patient uploads into one PDF per record.

Phone photos are rotated by an EXIF flag rather than in their pixels; the OCR pipeline rasterizes
with PyMuPDF, which ignores that flag, so a sideways photo would be read sideways. Photos are
therefore turned upright, downscaled, and written as pages of a single PDF.
"""

import io

import pymupdf
from PIL import Image, ImageOps

MAX_SIDE = 2400  # px; plenty for OCR at 200 dpi, keeps a 12 MP photo to ~1 MB
PAGE_DPI = 150

PDF_MAGIC = b"%PDF"
IMAGE_MAGIC = (b"\x89PNG", b"\xff\xd8\xff")


def is_pdf(data: bytes) -> bool:
    return data.startswith(PDF_MAGIC)


def is_image(data: bytes) -> bool:
    return data.startswith(IMAGE_MAGIC)


def images_to_pdf(images: list[bytes]) -> bytes:
    doc = pymupdf.open()
    for raw in images:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
        img.thumbnail((MAX_SIDE, MAX_SIDE))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85)
        page = doc.new_page(width=img.width * 72 / PAGE_DPI, height=img.height * 72 / PAGE_DPI)
        page.insert_image(page.rect, stream=buf.getvalue())
    out = doc.tobytes()
    doc.close()
    return out
