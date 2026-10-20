"""Deterministic derivations from validated timeline events: pending tests, discrepancies
(same-day measurement conflicts here; invariant-field conflicts in invariants.py), and lab
change flags. Pure code; no LLM. Same events in -> same output.
"""

import re
import uuid
from dataclasses import dataclass
from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from app.repositories.cases import CaseRepository, DocumentPageRepository, SourceDocumentRepository
from app.pipeline.invariants import invariant_conflicts
from app.repositories.timeline import DiscrepancyRepository, PendingTestRepository, TimelineEventRepository

# Test name keywords -> canonical test. A name can map to several tests ("mammogram and ultrasound").
TEST_KEYWORDS = {
    "echocardiogram": r"echo\w*|tte|transthoracic",
    "mammogram": r"mammogra\w*",
    "ultrasound": r"ultrasound|sonogra\w*",
    "pet_ct": r"pet(?:[-/ ]?ct)?",
    "molecular_panel": r"molecular|ngs|genomic\w*",
    "her2_fish": r"fish",
    "ct": r"ct(?! ?guided)",
    "mri": r"mri",
    "pft": r"pulmonary function|pfts?|spirometry",
    "biopsy": r"biopsy",
}
# Results of these analytes count as results of these tests.
ANALYTE_TEST = {"lvef": "echocardiogram", "fev1": "pft"}

ANALYTE_KEYWORDS = [
    ("lvef", r"lvef|ejection fraction|\bef\b"),
    ("lesion_size", r"size|mass|nodule|lesion|tumou?r"),
    ("hemoglobin", r"ha?emoglobin|\bhgb\b|\bhb\b"),
    ("fev1", r"fev1"),
]

LVEF_DROP_POINTS = 10.0


def canonical_tests(*names: str | None) -> set[str]:
    text = " ".join(n for n in names if n).lower()
    keys = {key for key, pat in TEST_KEYWORDS.items() if re.search(rf"\b(?:{pat})\b", text)}
    if "pet_ct" in keys:
        keys.discard("ct")
    return keys


def canonical_analyte(name: str | None) -> str | None:
    if not name:
        return None
    low = name.lower()
    for key, pat in ANALYTE_KEYWORDS:
        if re.search(pat, low):
            return key
    return re.sub(r"[^a-z0-9]+", "_", low).strip("_") or None


@dataclass(frozen=True)
class Fact:
    id: uuid.UUID
    event_date: date | None
    payload: dict[str, Any]
    source_page_id: uuid.UUID
    source_text_span: str
    document_id: uuid.UUID | None = None

    @property
    def kind(self) -> str | None:
        return self.payload.get("kind")

    def normalized_unit(self) -> str:
        unit = (self.payload.get("unit") or "").strip().lower()
        return "cm" if self.payload.get("analyte") == "lesion_size" and unit == "mm" else unit

    def tests(self) -> set[str]:
        """Canonical tests named by this fact. The test name wins; the description is a fallback
        (so "molecular panel on biopsy tissue" is not also a pending biopsy)."""
        return canonical_tests(self.payload.get("test_name")) or canonical_tests(self.payload.get("description"))

    def normalized_value(self) -> float | None:
        v = self.payload.get("value")
        if v is None:
            return None
        if self.payload.get("analyte") == "lesion_size" and (self.payload.get("unit") or "").lower() == "mm":
            return round(float(v) / 10, 4)
        return float(v)


def _result_tests(f: Fact) -> set[str]:
    keys = f.tests()
    if f.payload.get("analyte") in ANALYTE_TEST:
        keys.add(ANALYTE_TEST[f.payload["analyte"]])
    return keys


def pending_tests(facts: list[Fact]) -> list[tuple[str, Fact]]:
    """Ordered tests with no result dated on/after the order. One entry per test (latest order)."""
    results = [f for f in facts if f.kind == "test_result"]
    pending: dict[str, Fact] = {}
    for order in (f for f in facts if f.kind == "test_ordered"):
        for test in order.tests():
            resolved = any(
                test in _result_tests(r)
                and (r.event_date is None or order.event_date is None or r.event_date >= order.event_date)
                for r in results
            )
            if not resolved:
                prev = pending.get(test)
                if prev is None or (order.event_date or date.min) > (prev.event_date or date.min):
                    pending[test] = order
    return sorted(pending.items())


def _measurements(facts: list[Fact], analyte: str | None = None) -> list[Fact]:
    return [
        f for f in facts
        if f.kind == "test_result" and f.payload.get("analyte") and f.normalized_value() is not None
        and f.event_date is not None and (analyte is None or f.payload["analyte"] == analyte)
    ]


def discrepancies(facts: list[Fact]) -> list[tuple[Fact, Fact, str, str]]:
    """Same analyte, same unit, measured on the same date with different values."""
    out, seen = [], set()
    ms = sorted(_measurements(facts), key=lambda f: (f.event_date, str(f.id)))
    for i, a in enumerate(ms):
        for b in ms[i + 1 :]:
            if (a.payload["analyte"], a.event_date, a.normalized_unit()) != (
                b.payload["analyte"], b.event_date, b.normalized_unit()
            ):
                continue  # e.g. "FEV1 1.9 L" vs "68 % predicted" are different measures
            va, vb = a.normalized_value(), b.normalized_value()
            key = (a.payload["analyte"], a.event_date, frozenset((va, vb)))
            if va == vb or key in seen:
                continue
            seen.add(key)
            unit = a.normalized_unit()
            out.append((a, b, a.payload["analyte"],
                        f"{a.payload['analyte']} on {a.event_date.isoformat()}: {va:g}{unit} vs {vb:g}{unit}"))
    return out


def lab_flags(facts: list[Fact]) -> list[dict[str, Any]]:
    """LVEF drop of >= LVEF_DROP_POINTS from the highest earlier value."""
    flags = []
    by_date: dict[date, Fact] = {}
    for f in sorted(_measurements(facts, "lvef"), key=lambda f: (f.event_date, str(f.id))):
        by_date.setdefault(f.event_date, f)  # one reading per date
    peak: Fact | None = None
    for f in by_date.values():
        if peak is not None:
            drop = peak.normalized_value() - f.normalized_value()
            if drop >= LVEF_DROP_POINTS:
                flags.append({
                    "rule": "lvef_drop",
                    "analyte": "lvef",
                    "from_value": peak.normalized_value(),
                    "to_value": f.normalized_value(),
                    "points": drop,
                    "from_event_id": str(peak.id),
                    "to_event_id": str(f.id),
                    "message": (
                        f"LVEF decreased {drop:g} points ({peak.normalized_value():g}% on "
                        f"{peak.event_date.isoformat()} to {f.normalized_value():g}% on {f.event_date.isoformat()})"
                    ),
                })
        if peak is None or f.normalized_value() > peak.normalized_value():
            peak = f
    return flags


def facts_for_case(db: Session, org_id: uuid.UUID, case_id: uuid.UUID) -> list[Fact]:
    page_doc = {p.id: p.document_id for p in DocumentPageRepository(db, org_id).for_case(case_id)}
    return [
        Fact(e.id, e.event_date, e.payload or {}, e.source_page_id, e.source_text_span, page_doc.get(e.source_page_id))
        for e in TimelineEventRepository(db, org_id).for_case(case_id)
    ]


def run_derive(db: Session, org_id: uuid.UUID, case_id: uuid.UUID) -> dict[str, int]:
    """Recompute stored pending tests and discrepancies for a case (flags are computed on read)."""
    if CaseRepository(db, org_id).lock(case_id) is None:
        raise LookupError("case not found")
    facts = facts_for_case(db, org_id, case_id)
    pend_repo, disc_repo = PendingTestRepository(db, org_id), DiscrepancyRepository(db, org_id)
    pend_repo.delete_where(pend_repo.model.case_id == case_id)
    disc_repo.delete_where(disc_repo.model.case_id == case_id)

    pend = pending_tests(facts)
    for test, order in pend:
        pend_repo.add(
            case_id=case_id, test_name=test, ordered_date=order.event_date, status="pending",
            source_page_id=order.source_page_id, source_text_span=order.source_text_span,
            extracted_by="derived", payload={"order_event_id": str(order.id)},
        )
    doc_names = {d.id: d.filename for d in SourceDocumentRepository(db, org_id).for_case(case_id)}
    disc = discrepancies(facts) + invariant_conflicts(facts, doc_names)
    for a, b, analyte, description in disc:
        disc_repo.add(case_id=case_id, event_a_id=a.id, event_b_id=b.id, field=analyte, description=description)
    db.flush()
    return {"pending_tests": len(pend), "discrepancies": len(disc)}
