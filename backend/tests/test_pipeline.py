"""Extraction validation, derivations, and the timeline endpoint — with a fake LLM."""

from datetime import date

import pytest

from app.llm.client import Extraction
from app.pipeline.derive import Fact, discrepancies, lab_flags, pending_tests, run_derive
from app.pipeline.extraction import LlmExtraction, align_span, run_extraction
from app.repositories.cases import CaseRepository, DocumentPageRepository, SourceDocumentRepository
from app.repositories.timeline import RejectedExtractionRepository, TimelineEventRepository
from tests.conftest import login

PAGE_1 = "ECHO REPORT\nStudy date: 03/03/2025\nLeft ventricular ejection fraction: 62%.\nNormal valves."
PAGE_2 = (
    "ONCOLOGY NOTE\nDate of service: 2025-09-15\nEcho 2025-09-08: LVEF 48%.\n"
    "Repeat echocardiogram ordered for October 2025.\nFamily history: mother with breast cancer."
)


def fake_llm(events):
    return lambda text, schema, instructions: Extraction(LlmExtraction(events=events), "fake:model")


def make_doc(db, tenant, pages=(PAGE_1, PAGE_2)):
    case = CaseRepository(db, tenant.org.id).add(case_code="P-1", title="t", created_by_user_id=tenant.faculty.id)
    doc = SourceDocumentRepository(db, tenant.org.id).add(
        case_id=case.id, filename="notes.pdf", mime_type="application/pdf", storage_key="x/notes.pdf",
        uploaded_by_user_id=tenant.faculty.id,
    )
    for n, text in enumerate(pages, start=1):
        DocumentPageRepository(db, tenant.org.id).add(document_id=doc.id, page_number=n, ocr_text=text, confidence=0.9)
    return case, doc


GOOD = [
    {"page_number": 1, "source_text_span": "left ventricular ejection fraction: 62%",  # case differs: still matches
     "category": "imaging", "kind": "test_result", "description": "LVEF 62%", "date_text": "03/03/2025",
     "test_name": "echocardiogram", "analyte": "LVEF", "value": 62, "unit": "%"},
    {"page_number": 2, "source_text_span": "Echo 2025-09-08: LVEF 48%.", "category": "imaging",
     "kind": "test_result", "description": "LVEF 48%", "date_text": "2025-09-08",
     "test_name": "echo", "analyte": "LVEF", "value": 48, "unit": "%"},
    {"page_number": 2, "source_text_span": "Repeat echocardiogram ordered for October 2025.", "category": "imaging",
     "kind": "test_ordered", "description": "Repeat echo ordered", "date_text": "October 2025",
     "test_name": "echocardiogram"},
    {"page_number": 2, "source_text_span": "mother with breast cancer", "category": "other", "kind": "history",
     "description": "Family history", "date_text": None},
]
BAD = [
    {"page_number": 2, "source_text_span": "Patient started on doxorubicin last year", "category": "treatment",
     "kind": "treatment", "description": "hallucinated"},
    {"page_number": 9, "source_text_span": "Normal valves.", "category": "imaging", "kind": "finding",
     "description": "wrong page"},
    {"page_number": 1, "source_text_span": "Left ventricular ejection fraction: 62%.", "category": "imaging",
     "kind": "test_result", "description": "wrong value", "analyte": "LVEF", "value": 65},
    {"page_number": 1, "source_text_span": "Normal valves.", "category": "not-a-category", "kind": "finding",
     "description": "bad enum"},
    {"page_number": 1, "source_text_span": "Normal valves.", "category": "imaging", "kind": "finding",
     "description": "date not on page", "date_text": "2019-04-01"},
]


def test_align_span_returns_verbatim_page_text():
    score, matched = align_span("left ventricular  ejection fraction: 62%", PAGE_1)
    assert score >= 0.85 and matched in PAGE_1 and matched.startswith("Left")


def test_extraction_accepts_valid_and_rejects_invalid(db, org_a):
    case, doc = make_doc(db, org_a)
    summary = run_extraction(db, org_a.org.id, doc.id, extract=fake_llm(GOOD + BAD))
    assert (summary.accepted, summary.rejected) == (5, 4)

    events = TimelineEventRepository(db, org_a.org.id).for_case(case.id)
    pages = {p.id: p for p in DocumentPageRepository(db, org_a.org.id).for_document(doc.id)}
    for e in events:  # every stored span is verbatim OCR text of its page
        assert e.source_text_span in pages[e.source_page_id].ocr_text
        assert e.extracted_by == "fake:model"
    by_desc = {e.payload["description"]: e for e in events}
    assert (by_desc["LVEF 62%"].event_date, by_desc["LVEF 62%"].date_precision) == (date(2025, 3, 3), "exact")
    assert by_desc["Repeat echo ordered"].date_precision == "month"
    assert by_desc["Family history"].event_date is None
    assert by_desc["date not on page"].event_date is None  # hallucinated date dropped
    assert "doxorubicin" not in " ".join(e.source_text_span for e in events)

    reasons = sorted(r.reason for r in RejectedExtractionRepository(db, org_a.org.id).for_case(case.id))
    assert reasons == ["invalid_candidate", "page_out_of_range", "span_not_found", "value_not_in_span"]


def test_rerunning_extraction_replaces_previous_output(db, org_a):
    case, doc = make_doc(db, org_a)
    run_extraction(db, org_a.org.id, doc.id, extract=fake_llm(GOOD + BAD))
    run_extraction(db, org_a.org.id, doc.id, extract=fake_llm(GOOD))
    assert len(TimelineEventRepository(db, org_a.org.id).for_case(case.id)) == 4
    assert RejectedExtractionRepository(db, org_a.org.id).for_case(case.id) == []


def _fact(i, d, **payload):
    import uuid

    return Fact(uuid.UUID(int=i), d, payload, uuid.UUID(int=0), "span")


def test_pending_tests_rule():
    facts = [
        _fact(1, date(2026, 1, 5), kind="test_ordered", test_name="mammogram and breast ultrasound"),
        _fact(2, date(2026, 1, 9), kind="test_result", test_name="diagnostic mammogram"),
        _fact(3, date(2026, 1, 9), kind="test_result", test_name="breast ultrasound"),
        _fact(4, date(2026, 1, 15), kind="test_ordered", test_name="HER2 FISH"),
        _fact(5, date(2025, 10, 1), kind="test_ordered", test_name="repeat echocardiogram"),
        _fact(6, date(2025, 9, 8), kind="test_result", analyte="lvef", value=48),  # earlier: doesn't resolve
    ]
    assert [t for t, _ in pending_tests(facts)] == ["echocardiogram", "her2_fish"]


def test_pending_uses_test_name_over_description():
    # As Gemini extracted SYN-002: the specimen mention must not create a pending "biopsy".
    order = _fact(1, date(2026, 2, 16), kind="test_ordered", test_name="molecular panel",
                  description="Molecular panel ordered on biopsy tissue")
    assert [t for t, _ in pending_tests([order])] == ["molecular_panel"]


def test_discrepancy_rule():
    facts = [
        _fact(1, date(2026, 1, 9), kind="test_result", analyte="lesion_size", value=2.1, unit="cm"),
        _fact(2, date(2026, 1, 9), kind="test_result", analyte="lesion_size", value=19, unit="mm"),
        _fact(3, date(2026, 1, 9), kind="test_result", analyte="lesion_size", value=2.1, unit="cm"),
        _fact(4, date(2026, 2, 1), kind="test_result", analyte="lesion_size", value=3.0, unit="cm"),
    ]
    found = discrepancies(facts)
    assert len(found) == 1 and found[0][2] == "lesion_size"


def test_discrepancy_requires_same_unit():
    # As Gemini extracted SYN-002: "FEV1 1.9 L (68% predicted)" -> two FEV1 facts, not a conflict.
    facts = [_fact(1, date(2026, 2, 10), kind="test_result", analyte="fev1", value=1.9, unit="L"),
             _fact(2, date(2026, 2, 10), kind="test_result", analyte="fev1", value=68, unit="%")]
    assert discrepancies(facts) == []


def test_lvef_drop_flag():
    lvef = lambda i, d, v: _fact(i, d, kind="test_result", analyte="lvef", value=v)  # noqa: E731
    facts = [lvef(1, date(2025, 3, 3), 62), lvef(2, date(2025, 6, 9), 56), lvef(3, date(2025, 9, 8), 48),
             lvef(4, date(2025, 9, 8), 48)]  # same reading reported twice
    flags = lab_flags(facts)
    assert len(flags) == 1
    assert (flags[0]["from_value"], flags[0]["to_value"], flags[0]["points"]) == (62, 48, 14)
    assert lab_flags([lvef(1, date(2025, 3, 3), 62), lvef(2, date(2025, 6, 9), 53)]) == []  # 9 points


def test_timeline_endpoint(client, db, org_a, org_b):
    case, doc = make_doc(db, org_a)
    run_extraction(db, org_a.org.id, doc.id, extract=fake_llm(GOOD))
    run_derive(db, org_a.org.id, case.id)

    r = client.get(f"/cases/{case.id}/timeline", headers=login(client, org_a, org_a.faculty))
    assert r.status_code == 200
    body = r.json()
    dates = [e["event_date"] for e in body["events"]]
    assert dates == sorted(dates) and None not in dates
    assert body["date_unclear"]["label"] == "Date unclear"
    assert [e["description"] for e in body["date_unclear"]["events"]] == ["Family history"]
    assert body["events"][0]["source"]["page_url"] == f"/documents/{doc.id}/pages/1"
    assert [t["test_name"] for t in body["pending_tests"]] == ["echocardiogram"]
    assert [f["rule"] for f in body["flags"]] == ["lvef_drop"]

    page = client.get(body["events"][0]["source"]["page_url"], headers=login(client, org_a, org_a.faculty))
    assert page.status_code == 200 and "62%" in page.json()["ocr_text"]

    headers_b = login(client, org_b, org_b.resident)
    assert client.get(f"/cases/{case.id}/timeline", headers=headers_b).status_code == 404
    assert client.get(f"/documents/{doc.id}/pages/1", headers=headers_b).status_code == 404
    assert client.get(f"/documents/{doc.id}/pages/1/image", headers=headers_b).status_code == 404


@pytest.mark.skipif(__import__("shutil").which("tesseract") is None, reason="tesseract not installed")
def test_tesseract_reads_rendered_page():
    from PIL import Image, ImageDraw, ImageFont

    from app.pipeline.ocr import ocr_tesseract

    img = Image.new("L", (1200, 300), 255)
    ImageDraw.Draw(img).text((40, 100), "Left ventricular ejection fraction: 48%.", font=ImageFont.load_default(size=40), fill=0)
    result = ocr_tesseract(img)
    assert "ejection fraction" in result.text and result.confidence > 0.5


DRUG_PAGES = (
    "CHEMO RECORD\nCycle 1 on 01/06/2025: trastuzumab 8 mg/kg loading dose.\nPantoprazole 40 mg once daily.",
    "CHEMO RECORD\nCycle 2 on 01/27/2025: trastuzumab 6 mg/kg every 3 weeks.\nHemoglobin 11.2 g/dL on 01/27/2025.",
)


def test_drugs_and_doses_are_read_from_records_and_graphed(db, org_a):
    from app.services.timeline import build_timeline
    from app.services.trends import record_trends

    case, doc = make_doc(db, org_a, DRUG_PAGES)
    drug = lambda page, span, name, dose, unit, freq, date_text: {  # noqa: E731
        "page_number": page, "source_text_span": span, "category": "treatment", "kind": "treatment",
        "description": f"{name} {dose} {unit}", "date_text": date_text, "drug": name, "dose": dose, "dose_unit": unit,
        "frequency": freq}
    events = [
        drug(1, "trastuzumab 8 mg/kg loading dose", "trastuzumab", 8, "mg/kg", None, "01/06/2025"),
        drug(2, "trastuzumab 6 mg/kg every 3 weeks", "Trastuzumab", 6, "mg/kg", "every 3 weeks", "01/27/2025"),
        {**drug(1, "Pantoprazole 40 mg once daily", "Pantoprazole", 40, "mg", "once daily", None), "category": "other"},
        {"page_number": 2, "source_text_span": "Hemoglobin 11.2 g/dL on 01/27/2025", "category": "lab",
         "kind": "test_result", "description": "Hb 11.2", "date_text": "01/27/2025", "analyte": "hemoglobin",
         "value": 11.2, "unit": "g/dL"},
        # rejected: the dose is not on the page; the drug is not on the page
        drug(1, "trastuzumab 8 mg/kg loading dose", "trastuzumab", 80, "mg/kg", None, "01/06/2025"),
        drug(1, "Pantoprazole 40 mg once daily", "omeprazole", 40, "mg", None, None),
    ]
    summary = run_extraction(db, org_a.org.id, doc.id, extract=fake_llm(events))
    assert (summary.accepted, summary.rejected) == (4, 2)

    out = record_trends(db, org_a.org.id, case.id, build_timeline(db, org_a.org.id, case.id))
    meds = {m["drug"].lower(): m for m in out["medicines"]}
    assert set(meds) == {"pantoprazole", "trastuzumab"}  # "Trastuzumab" and "trastuzumab" are one drug
    t = meds["trastuzumab"]
    assert [(str(e["date"]), e["dose"], e["unit"]) for e in t["entries"]] == [("2025-01-06", 8, "mg/kg"), ("2025-01-27", 6, "mg/kg")]
    assert t["latest"]["frequency"] == "every 3 weeks" and t["entries"][0]["source"]["page_number"] == 1
    assert meds["pantoprazole"]["entries"][0]["date"] is None  # undated page: still listed, no date
    hb = next(s for s in out["labs"] if s["key"] == "hemoglobin")
    assert (hb["label"], hb["unit"], [p["value"] for p in hb["points"]]) == ("hemoglobin", "g/dL", [11.2])


def test_undated_medicine_lines_take_their_page_date(db, org_a):
    from app.services.trends import record_trends

    case, doc = make_doc(db, org_a, ("CLINIC NOTE\nDate of service: 2025-07-20\nMedications: furosemide 20 mg daily.",))
    run_extraction(db, org_a.org.id, doc.id, extract=fake_llm([
        {"page_number": 1, "source_text_span": "furosemide 20 mg daily", "category": "other", "kind": "treatment",
         "description": "furosemide 20 mg daily", "drug": "furosemide", "dose": 20, "dose_unit": "mg", "frequency": "daily"}]))
    entry = record_trends(db, org_a.org.id, case.id)["medicines"][0]["entries"][0]
    assert (str(entry["date"]), entry["date_basis"]) == ("2025-07-20", "document")


def test_blood_pressure_is_not_graphed_and_one_value_per_date():
    from app.services.trends import lab_series

    src = {"document_id": "d", "filename": "n.pdf", "page_number": 1}
    ev = lambda analyte, value, d: {"event_date": d, "source": src, "description": "", "payload": {  # noqa: E731
        "analyte": analyte, "analyte_text": analyte, "value": value, "unit": "x"}}
    timeline = {"events": [ev("blood pressure", 124, "2026-07-20"), ev("blood pressure", 78, "2026-07-20"),
                           ev("pulse", 80, "2026-07-20"), ev("pulse", 82, "2026-07-20"), ev("pulse", 90, "2026-08-01")],
                "date_unclear": {"events": []}}
    series = lab_series(timeline)
    assert [s["key"] for s in series] == ["pulse_rate"]
    assert [p["value"] for p in series[0]["points"]] == [80, 90]
