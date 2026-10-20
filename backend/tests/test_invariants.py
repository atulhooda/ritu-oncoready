"""Conflicts in fields that should not change without a documented event (stage, histology,
primary site, HER2/ER/PR), compared across documents regardless of date."""

import json
import uuid
from datetime import date
from pathlib import Path

import pytest

from app.llm.client import Extraction
from app.pipeline.derive import Fact, run_derive
from app.pipeline.extraction import LlmExtraction, run_extraction
from app.pipeline.invariants import invariant_conflicts
from app.repositories.cases import CaseRepository, DocumentPageRepository, SourceDocumentRepository
from app.repositories.timeline import DiscrepancyRepository, RejectedExtractionRepository
from tests.conftest import login

SYN_002 = json.loads(
    (Path(__file__).resolve().parents[2] / "seed" / "cases" / "SYN-002" / "case.json").read_text()
)
OUTSIDE_CT, PULM_NOTE = "syn-002_outside_ct.pdf", "syn-002_pulm_note.pdf"

# What an LLM would propose for SYN-002's staging and histology lines (spans are page text).
CANDIDATES = {
    OUTSIDE_CT: [
        {"page_number": 1, "source_text_span": "Impression: radiographic stage cT1c N0 M0 (stage IA3).",
         "category": "imaging", "kind": "finding", "description": "Outside radiographic stage",
         "date_text": "2 Feb 2026", "attribute": "stage", "attribute_value": "cT1c N0 M0 (stage IA3)"},
    ],
    PULM_NOTE: [
        {"page_number": 1, "source_text_span": "Preliminary pathology: adenocarcinoma.", "category": "pathology",
         "kind": "finding", "description": "Adenocarcinoma", "attribute": "histology",
         "attribute_value": "adenocarcinoma"},
        {"page_number": 1, "source_text_span": "EBUS station 4R lymph node: adenocarcinoma.", "category": "pathology",
         "kind": "finding", "description": "4R node positive", "attribute": "histology",
         "attribute_value": "adenocarcinoma"},
        {"page_number": 2, "source_text_span": "Clinical stage (tumor board 2026-02-18): cT1c N2 M0, stage IIIA.",
         "category": "other", "kind": "finding", "description": "In-house clinical stage",
         "date_text": "2026-02-18", "attribute": "Clinical stage", "attribute_value": "cT1c N2 M0, stage IIIA"},
    ],
}

RESTAGING_PAGE = (
    "RESTAGING CT CHEST\nResponse assessment 2026-05-20: partial response after 3 cycles of chemotherapy.\n"
    "Restaged 2026-06-01: cT1a N1 M0, stage IIB."
)
RESPONSE = {"page_number": 1, "source_text_span": "partial response after 3 cycles of chemotherapy",
            "category": "imaging", "kind": "response_assessment", "description": "Partial response",
            "date_text": "2026-05-20"}
RESTAGE = {"page_number": 1, "source_text_span": "Restaged 2026-06-01: cT1a N1 M0, stage IIB.", "category": "imaging",
           "kind": "finding", "description": "Restaged", "date_text": "2026-06-01", "attribute": "stage",
           "attribute_value": "cT1a N1 M0, stage IIB"}


def fake_llm(events):
    return lambda text, schema, instructions: Extraction(LlmExtraction(events=events), "fake:model")


def add_doc(db, tenant, case, filename, pages):
    doc = SourceDocumentRepository(db, tenant.org.id).add(
        case_id=case.id, filename=filename, mime_type="application/pdf", storage_key=f"t/{filename}",
        uploaded_by_user_id=tenant.faculty.id,
    )
    for n, text in enumerate(pages, start=1):
        DocumentPageRepository(db, tenant.org.id).add(document_id=doc.id, page_number=n, ocr_text=text, confidence=1.0)
    return doc


def load_syn_002(db, tenant):
    """SYN-002's documents, with ground-truth page text standing in for OCR."""
    case = CaseRepository(db, tenant.org.id).add(
        case_code="SYN-002", title=SYN_002["title"], created_by_user_id=tenant.faculty.id
    )
    for d in SYN_002["documents"]:
        doc = add_doc(db, tenant, case, d["filename"], ["\n".join(lines) for lines in d["pages"]])
        run_extraction(db, tenant.org.id, doc.id, extract=fake_llm(CANDIDATES[d["filename"]]))
    return case


def stage_discrepancies(db, tenant, case):
    return [d for d in DiscrepancyRepository(db, tenant.org.id).for_case(case.id) if d.field == "stage"]


def test_syn_002_staging_conflict_survives_ocr_errors(db, org_a):
    """Text exactly as PaddleOCR read the rendered SYN-002 pages: "NO MO", "stage IIA"."""
    case = CaseRepository(db, org_a.org.id).add(case_code="SYN-002", title="t", created_by_user_id=org_a.faculty.id)
    ct = add_doc(db, org_a, case, OUTSIDE_CT, ["Exam date: 2 Feb 2026\nImpression: radiographic stage cT1c NO MO (stage IA3)."])
    note = add_doc(db, org_a, case, PULM_NOTE, ["Clinical stage (tumor board 2026-02-18): cT1c N2 M0, stage IIA."])
    run_extraction(db, org_a.org.id, ct.id, extract=fake_llm([CANDIDATES[OUTSIDE_CT][0] | {
        "source_text_span": "radiographic stage cT1c NO MO (stage IA3).", "attribute_value": "cT1c NO MO (stage IA3)"}]))
    run_extraction(db, org_a.org.id, note.id, extract=fake_llm([CANDIDATES[PULM_NOTE][2] | {
        "page_number": 1, "source_text_span": "cT1c N2 M0, stage IIA.", "attribute_value": "cT1c N2 M0, stage IIA"}]))
    run_derive(db, org_a.org.id, case.id)
    assert len(stage_discrepancies(db, org_a, case)) == 1


def test_syn_002_outside_vs_in_house_staging_is_a_discrepancy(client, db, org_a):
    case = load_syn_002(db, org_a)
    run_derive(db, org_a.org.id, case.id)

    stages = stage_discrepancies(db, org_a, case)
    assert len(stages) == 1
    desc = stages[0].description
    assert OUTSIDE_CT in desc and PULM_NOTE in desc
    assert "cT1c N0 M0" in desc and "cT1c N2 M0" in desc
    # Same histology in both pulm-note facts, and the CT states none: no histology conflict.
    assert [d.field for d in DiscrepancyRepository(db, org_a.org.id).for_case(case.id)] == ["stage"]

    body = client.get(f"/cases/{case.id}/timeline", headers=login(client, org_a, org_a.resident)).json()
    assert [d["field"] for d in body["discrepancies"]] == ["stage"]


def test_restaging_after_documented_response_is_not_a_discrepancy(db, org_a):
    case = load_syn_002(db, org_a)
    doc = add_doc(db, org_a, case, "syn-002_restaging_ct.pdf", [RESTAGING_PAGE])
    run_extraction(db, org_a.org.id, doc.id, extract=fake_llm([RESPONSE, RESTAGE]))
    run_derive(db, org_a.org.id, case.id)

    # Only the original outside-vs-in-house conflict; the post-response restage is excused.
    stages = stage_discrepancies(db, org_a, case)
    assert len(stages) == 1 and "IIB" not in stages[0].description


def test_restaging_without_documented_response_is_a_discrepancy(db, org_a):
    case = load_syn_002(db, org_a)
    doc = add_doc(db, org_a, case, "syn-002_restaging_ct.pdf", [RESTAGING_PAGE])
    run_extraction(db, org_a.org.id, doc.id, extract=fake_llm([RESTAGE]))
    run_derive(db, org_a.org.id, case.id)

    assert len(stage_discrepancies(db, org_a, case)) == 3  # every pair of differing stages


def test_field_value_must_be_in_span(db, org_a):
    case = CaseRepository(db, org_a.org.id).add(case_code="X", title="t", created_by_user_id=org_a.faculty.id)
    doc = add_doc(db, org_a, case, "x.pdf", [RESTAGING_PAGE])
    bad = RESTAGE | {"attribute_value": "cT4 N3 M1, stage IVB"}
    run_extraction(db, org_a.org.id, doc.id, extract=fake_llm([bad]))
    assert [r.reason for r in RejectedExtractionRepository(db, org_a.org.id).for_case(case.id)] == ["value_not_in_span"]


# --- pure rules ------------------------------------------------------------------------

DOC_A, DOC_B = uuid.uuid4(), uuid.uuid4()


def fact(i, d, attribute, value, doc=DOC_A, kind="finding"):
    payload = {"kind": kind, "attribute": attribute, "attribute_value": value}
    return Fact(uuid.UUID(int=i), d, payload, uuid.UUID(int=0), value, doc)


@pytest.mark.parametrize(
    "attribute, a, b, conflict",
    [
        ("her2", "2+ (equivocal)", "FISH amplified", False),
        ("her2", "3+ (positive)", "0 (negative)", True),
        ("her2", "3+", "FISH amplified", False),
        ("er", "positive (90%)", "negative (<1%)", True),
        ("pr", "positive (60%)", "positive (5%)", False),
        ("histology", "adenocarcinoma", "squamous cell carcinoma", True),
        ("histology", "non-small cell lung carcinoma", "adenocarcinoma", False),
        ("histology", "invasive ductal carcinoma", "invasive lobular carcinoma", True),
        ("primary_site", "left breast", "right breast", True),
        ("primary_site", "right upper lobe", "RUL", False),
        ("primary_site", "lung", "right lower lobe", False),
        ("stage", "cT2 N0 M0", "cT2 N1 M0", True),
        ("stage", "cT2 N1 M0", "pT2 N0 M0", False),  # clinical vs pathologic: different systems
        ("stage", "cT2 N1 M0", "ypT1 N0 M0", False),  # post-therapy stage is its own system
        ("stage", "stage IIIA", "stage 3A", False),
        ("stage", "cT1c NO MO (stage IA3)", "cT1c N0 M0", False),  # OCR letter O for zero
        ("stage", "cT1c NO MO (stage IA3)", "cT1c N2 M0, stage IIA", True),  # as OCR'd in SYN-002
    ],
)
def test_field_rules(attribute, a, b, conflict):
    facts = [fact(1, date(2026, 1, 1), attribute, a, DOC_A), fact(2, date(2026, 3, 1), attribute, b, DOC_B)]
    assert bool(invariant_conflicts(facts)) is conflict


def test_one_discrepancy_per_document_pair():
    # As Gemini extracted SYN-002's in-house line: TNM and stage group as two facts.
    facts = [fact(1, date(2026, 2, 2), "stage", "cT1c NO MO (stage IA3)", DOC_A),
             fact(2, date(2026, 2, 18), "stage", "cT1c N2 M0", DOC_B),
             fact(3, date(2026, 2, 18), "stage", "stage IIA", DOC_B)]
    assert len(invariant_conflicts(facts)) == 1


def test_same_document_is_not_compared():
    facts = [fact(1, date(2026, 1, 1), "stage", "cT2 N0 M0"), fact(2, date(2026, 1, 1), "stage", "cT2 N1 M0")]
    assert invariant_conflicts(facts) == []


def test_conflicts_regardless_of_date_and_undated_stage_is_never_excused():
    response = fact(3, date(2026, 2, 1), None, None, DOC_B, kind="response_assessment")
    dated = [fact(1, date(2024, 1, 1), "histology", "adenocarcinoma", DOC_A),
             fact(2, date(2026, 6, 1), "histology", "squamous cell carcinoma", DOC_B), response]
    assert len(invariant_conflicts(dated)) == 1  # the response only excuses stage changes

    undated = [fact(1, None, "stage", "cT2 N0 M0", DOC_A), fact(2, date(2026, 6, 1), "stage", "cT2 N1 M0", DOC_B),
               response]
    assert len(invariant_conflicts(undated)) == 1
