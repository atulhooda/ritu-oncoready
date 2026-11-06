from datetime import UTC, date, datetime

from tests.test_intake import no_background  # noqa: F401  (autouse: no Celery in tests)
from app.services.readiness import (
    last_visit, lab_changes, medicine_changes, milestones, missing, patient_reports, readiness,
)


def src(page=1, span="x", doc="d1"):
    return {"document_id": doc, "filename": f"{doc}.pdf", "page_number": page, "page_url": "", "image_url": "", "text_span": span}


def ev(i, when, category, description, **payload):
    return {"id": f"e{i}", "event_date": when, "date_precision": "exact" if when else "unknown", "category": category,
            "description": description, "payload": {"description": description, **payload}, "source": src(span=description)}


def fact(label, section, ended, urgent=False, **details):
    return {"section": section, "fact": {"id": label, "label": label, "urgent": urgent, "details": details,
                                          "quote": f"I said {label}", "turn_index": 3}, "ended": ended}


def session(sid, ended, *facts):
    sections = {}
    for f in facts:
        sections.setdefault(f["section"], []).append(f["fact"])
    return {"session_id": sid, "ended_at": ended, "sections": [{"section": k, "facts": v} for k, v in sections.items()]}


OCT1, NOV2 = datetime(2026, 10, 1, 9, tzinfo=UTC), datetime(2026, 11, 2, 9, tzinfo=UTC)


def test_last_visit_prefers_an_approved_consultation_then_the_latest_clinic_note():
    notes = [ev(1, date(2026, 9, 1), "consult", "clinic visit"), ev(2, date(2026, 10, 12), "consult", "clinic visit"),
             ev(3, date(2026, 10, 30), "imaging", "CT chest")]
    assert last_visit([{"approved_at": OCT1}], notes) == {"date": date(2026, 10, 1), "basis": "consultation", "source": None}
    v = last_visit([{"approved_at": None}], notes)
    assert (v["date"], v["basis"]) == (date(2026, 10, 12), "record") and v["source"]["text_span"] == "clinic visit"
    assert last_visit([], [ev(3, date(2026, 10, 30), "imaging", "CT chest")]) is None


def test_lab_changes_pair_the_last_value_before_with_the_latest_after():
    labs = [
        {"label": "Hemoglobin", "unit": "g/dL", "points": [
            {"date": date(2026, 9, 20), "value": 11.8, "source": src()},
            {"date": date(2026, 10, 1), "value": 11.2, "source": src()},  # on the visit day: "before"
            {"date": date(2026, 10, 20), "value": 10.1, "source": src()},
            {"date": date(2026, 11, 1), "value": 9.8, "source": src()}]},
        {"label": "LVEF", "unit": "%", "points": [{"date": date(2026, 8, 1), "value": 60, "source": src()}]},  # nothing new
        {"label": "Platelets", "unit": None, "points": [{"date": date(2026, 10, 15), "value": 210, "source": src()}]},
    ]
    out = lab_changes(labs, date(2026, 10, 1))
    assert [(c["label"], c["before"] and c["before"]["value"], c["after"]["value"], c["readings_since"]) for c in out] == [
        ("Hemoglobin", 11.2, 9.8, 2), ("Platelets", None, 210, 1)]
    assert all(set(c) == {"label", "unit", "before", "after", "readings_since"} for c in out)  # values only, no verdict


def test_medicine_changes_are_new_or_a_different_dose_never_stopped():
    def entry(d, dose, unit="mg"):
        return {"date": d, "date_basis": "stated", "dose": dose, "unit": unit, "frequency": None, "description": None, "source": src()}
    meds = [
        {"drug": "Tamoxifen", "entries": [entry(date(2026, 9, 1), 20), entry(date(2026, 10, 20), 20)]},  # same dose
        {"drug": "Capecitabine", "entries": [entry(date(2026, 9, 1), 1000), entry(date(2026, 10, 20), 750)]},
        {"drug": "Ondansetron", "entries": [entry(date(2026, 10, 25), 8)]},
        {"drug": "Letrozole", "entries": [entry(date(2026, 8, 1), 2.5)]},  # only before: NOT reported as stopped
    ]
    out = medicine_changes(meds, date(2026, 10, 1))
    assert [(m["drug"], m["change"], m["before"] and m["before"]["dose"], m["after"]["dose"]) for m in out] == [
        ("Capecitabine", "dose", 1000, 750), ("Ondansetron", "new", None, 8)]


def test_patient_reports_only_count_conversations_after_the_visit():
    history = [
        session("s2", NOV2, fact("fever", "current_symptom", NOV2, urgent=True), fact("ER visit", "recent_care", NOV2),
                fact("paracetamol", "medication", NOV2)),
        session("s1", datetime(2026, 9, 20, tzinfo=UTC), fact("nausea", "current_symptom", None)),
    ]
    out = patient_reports(history, date(2026, 10, 1))
    assert out["conversations"] == 1
    assert [f["label"] for f in out["symptoms"]] == ["fever"] and out["symptoms"][0]["urgent"] is True
    assert out["symptoms"][0]["quote"] == "I said fever" and out["symptoms"][0]["session_id"] == "s2"
    assert [f["label"] for f in out["hospital_visits"]] == ["ER visit"]
    assert [f["label"] for f in out["medicines"]] == ["paracetamol"]


def test_missing_lists_what_the_patient_mentioned_but_the_records_do_not_have():
    history = [session("s1", NOV2,
                       fact("CT scan of the chest", "previous_record", NOV2, record_type="CT", record_date="September"),
                       fact("echo report", "previous_record", NOV2),  # an echo IS in the records
                       fact("Ashwagandha", "medication", NOV2), fact("tamoxifen 20 mg", "medication", NOV2))]
    events = [ev(1, date(2026, 9, 1), "imaging", "Echocardiogram, LVEF 58%", test_name="echocardiogram")]
    records = [{"id": "d1", "filename": "outside_echo.pdf", "status": "ready", "error": None, "uploaded_at": OCT1},
               {"id": "d2", "filename": "scan.pdf", "status": "failed", "error": "unreadable PDF", "uploaded_at": OCT1}]
    meds = [{"drug": "Tamoxifen", "entries": []}]
    pages = [{"document_id": "d1", "filename": "outside_echo.pdf", "page_number": 2, "confidence": 0.41},
             {"document_id": "d1", "filename": "outside_echo.pdf", "page_number": 1, "confidence": 0.93},
             {"document_id": "d3", "filename": "seed.pdf", "page_number": 1, "confidence": None}]
    undated = [ev(9, None, "lab", "Hb 10 g/dL")]
    out = missing(history, events, undated, records, meds, pages)
    kinds = [m["kind"] for m in out]
    assert kinds == ["record_not_uploaded", "medicine_not_in_records", "page_hard_to_read", "facts_without_date", "record_failed"]
    assert out[0]["tests"] == ["ct"] and out[0]["record_date"] == "September" and out[0]["quote"] == "I said CT scan of the chest"
    assert out[1]["label"] == "Ashwagandha"  # tamoxifen is in the records
    assert (out[2]["page_number"], out[2]["confidence"]) == (2, 0.41)
    assert out[3]["count"] == 1 and out[4]["error"] == "unreadable PDF"


def test_a_record_named_by_its_file_counts_as_uploaded():
    history = [session("s1", NOV2, fact("PET CT", "previous_record", NOV2))]
    records = [{"id": "d1", "filename": "pet_ct_aug.pdf", "status": "ready", "error": None, "uploaded_at": OCT1}]
    assert missing(history, [], [], records, [], []) == []


def test_milestones_come_from_the_records_with_cycle_numbers_as_written():
    events = [
        ev(1, date(2026, 3, 3), "pathology", "Core biopsy: invasive ductal carcinoma"),
        ev(2, date(2026, 4, 1), "treatment", "AC chemotherapy cycle 1 of 4", kind="treatment"),
        ev(3, date(2026, 5, 13), "treatment", "AC C3D1 given", kind="treatment"),
        ev(4, date(2026, 7, 1), "procedure", "Lumpectomy"),
        ev(5, date(2026, 6, 9), "imaging", "MRI breast"), ev(6, date(2026, 9, 8), "imaging", "CT chest"),
        ev(7, date(2026, 9, 9), "other", "Partial response", kind="response_assessment"),
        ev(10, date(2026, 9, 20), "imaging", "PET-CT ordered", kind="test_ordered"),  # an order: not a milestone
        ev(8, None, "treatment", "cycle 9 (undated)", kind="treatment"),
    ]
    out = milestones(events)
    assert [(m["label"], m["date"]) for m in out] == [
        ("First pathology report", date(2026, 3, 3)), ("First treatment in the records", date(2026, 4, 1)),
        ("Latest cycle", date(2026, 5, 13)), ("Procedure", date(2026, 7, 1)),
        ("Latest imaging", date(2026, 9, 8)), ("Latest response assessment", date(2026, 9, 9))]
    cyc = out[2]
    assert (cyc["cycle"], cyc["of"]) == (3, None) and cyc["source"]["text_span"] == "AC C3D1 given"


def test_readiness_without_an_earlier_visit_has_no_changes_but_keeps_the_rest():
    timeline = {"events": [ev(1, date(2026, 3, 3), "pathology", "biopsy")], "date_unclear": {"events": []},
                "pending_tests": [{"id": "p1", "test_name": "pet_ct"}],
                "discrepancies": [{"id": "x", "field": "stage", "description": "IIA vs IIB", "status": "open", "event_ids": ["e1", "gone"]}]}
    out = readiness(timeline=timeline, medicines=[], labs=[], history=[], records=[], consultations=[], pages=[])
    assert out["last_visit"] is None and out["changes"] is None
    assert out["pending_tests"][0]["test_name"] == "pet_ct"
    assert [e["id"] for e in out["inconsistent"][0]["events"]] == ["e1"]  # both sides shown, missing ids dropped
    assert out["milestones"][0]["label"] == "First pathology report"


def test_readiness_changes_since_the_visit():
    timeline = {"events": [ev(1, date(2026, 9, 1), "consult", "clinic visit"), ev(2, date(2026, 10, 5), "imaging", "CT chest"),
                           ev(3, date(2026, 10, 6), "lab", "Hb 9.8", value=9.8),
                           ev(4, date(2026, 10, 6), "treatment", "Ondansetron 8 mg", drug="Ondansetron", dose=8)],
                "date_unclear": {"events": []}, "pending_tests": [], "discrepancies": []}
    records = [{"id": "d1", "filename": "old.pdf", "status": "ready", "error": None, "uploaded_at": datetime(2026, 8, 1, tzinfo=UTC)},
               {"id": "d2", "filename": "ct.pdf", "status": "ready", "error": None, "uploaded_at": OCT1}]
    out = readiness(timeline=timeline, medicines=[], labs=[], history=[], records=records, consultations=[], pages=[])
    assert out["last_visit"]["date"] == date(2026, 9, 1)
    assert [r["filename"] for r in out["changes"]["new_records"]] == ["ct.pdf"]
    # the Hb value and the medicine have their own before -> after lists
    assert [e["description"] for e in out["changes"]["events"]] == ["CT chest"]


# ---- through the API: a sent patient with Indian-dated records ------------------------------------

INDIAN_PAGES = (
    "OPD NOTE\nVisit date: 05/10/2026\nClinic visit, cycle 3 of 6 given.\nHb 11.2 g/dL on 03/10/2026.\n"
    "Capecitabine 1000 mg twice daily.\nCT chest ordered.",
    "DAY CARE\nDate of service: 02/11/2026\nHb 9.8 g/dL on 01/11/2026.\nCapecitabine 750 mg twice daily.",
)


def test_doctor_sees_readiness_built_from_the_records_and_the_patient(client, db, org_a):
    from app.pipeline.extraction import run_extraction
    from app.repositories.cases import DocumentPageRepository, SourceDocumentRepository
    from app.models import Role
    from tests.test_hierarchy import add_doctor, doctor_headers, sent_patient
    from tests.test_intake import as_user, person
    from tests.test_pipeline import fake_llm

    hh = as_user(client, org_a, person(db, org_a, Role.HOSPITAL, "City Hospital"))
    junior = add_doctor(client, hh, "Dr Jain", "junior")
    case_id = sent_patient(client, db, org_a, "Asha Placeholder")
    doc = SourceDocumentRepository(db, org_a.org.id).add(
        case_id=case_id, filename="opd.pdf", mime_type="application/pdf", storage_key="x/opd.pdf",
        uploaded_by_user_id=org_a.faculty.id)
    for n, text in enumerate(INDIAN_PAGES, start=1):
        DocumentPageRepository(db, org_a.org.id).add(document_id=doc.id, page_number=n, ocr_text=text, confidence=0.9 if n == 1 else 0.5)
    e = lambda page, span, **kw: {"page_number": page, "source_text_span": span, "description": span, **kw}  # noqa: E731
    run_extraction(db, org_a.org.id, doc.id, extract=fake_llm([
        e(1, "Clinic visit, cycle 3 of 6 given.", category="consult", kind="other", date_text="05/10/2026"),
        e(1, "Hb 11.2 g/dL on 03/10/2026", category="lab", kind="test_result", date_text="03/10/2026", analyte="hemoglobin", value=11.2, unit="g/dL"),
        e(1, "Capecitabine 1000 mg twice daily", category="treatment", kind="treatment", date_text="05/10/2026", drug="Capecitabine", dose=1000, dose_unit="mg"),
        e(1, "CT chest ordered", category="imaging", kind="test_ordered", date_text="05/10/2026", test_name="CT chest"),
        e(2, "Hb 9.8 g/dL on 01/11/2026", category="lab", kind="test_result", date_text="01/11/2026", analyte="hemoglobin", value=9.8, unit="g/dL"),
        e(2, "Capecitabine 750 mg twice daily", category="treatment", kind="treatment", date_text="02/11/2026", drug="Capecitabine", dose=750, dose_unit="mg"),
    ]))
    from app.pipeline.derive import run_derive
    run_derive(db, org_a.org.id, case_id)

    r = client.get(f"/doctor/patients/{case_id}", headers=doctor_headers(client, org_a, junior["email"])).json()["readiness"]
    assert r["last_visit"]["date"] == "2026-10-05" and r["last_visit"]["basis"] == "record"  # day-first: 5 Oct, not 10 May
    hb = r["changes"]["labs"][0]
    assert (hb["before"]["value"], hb["before"]["date"], hb["after"]["value"], hb["after"]["date"]) == (11.2, "2026-10-03", 9.8, "2026-11-01")
    assert hb["after"]["source"]["page_number"] == 2
    med = r["changes"]["medicines"][0]
    assert (med["drug"], med["change"], med["before"]["dose"], med["after"]["dose"]) == ("Capecitabine", "dose", 1000, 750)
    assert [s["label"] for s in r["changes"]["patient"]["symptoms"]] == ["Breathlessness on stairs", "Evening ankle swelling"]
    assert [t["test_name"] for t in r["pending_tests"]] == ["ct"]
    kinds = {m["kind"]: m for m in r["missing"]}
    assert kinds["record_not_uploaded"]["tests"] == ["echocardiogram"] and kinds["record_not_uploaded"]["facility"] == "Heart Associates"
    assert kinds["medicine_not_in_records"]["label"] == "Trastuzumab every 3 weeks"
    assert kinds["page_hard_to_read"]["page_number"] == 2
    cyc = next(m for m in r["milestones"] if m["label"] == "Latest cycle")
    assert (cyc["cycle"], cyc["of"]) == (3, 6)
    assert "flags" not in client.get(f"/doctor/patients/{case_id}", headers=doctor_headers(client, org_a, junior["email"])).json()["timeline"]
