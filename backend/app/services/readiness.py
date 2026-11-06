"""Consultation readiness: what the doctor needs before a follow-up, in one place. What changed
since the last visit, what is still pending, what is missing or does not agree, and where the
patient is in their care. Pure code over facts that already carry their source (a record page or
the patient's own words); nothing is inferred and nothing is judged. A change is shown as the two
values with their dates and sources, never as better or worse, high or low (CLAUDE.md rule 2)."""

import re
import uuid
from datetime import UTC, date, datetime
from typing import Any

from rapidfuzz import fuzz
from sqlalchemy.orm import Session

from app.pipeline.dates import document_orders, page_date
from app.pipeline.derive import canonical_tests
from app.repositories.cases import DocumentPageRepository
from app.repositories.consultations import ConsultationRepository

# A page read with less confidence than this may have lost words; the doctor should look at it.
LOW_OCR_CONFIDENCE = 0.6
# How closely a medicine the patient names must match one in the records (rapidfuzz partial ratio).
DRUG_MATCH = 85
# "cycle 4", "cycle 4 of 6", "cycle #4/6", and the C4D1 (cycle 4, day 1) shorthand.
# A page that states a visit date is a clinic visit, whatever the extractor called its facts.
VISIT_LINE = re.compile(r"^\s*(?:visit date|date of visit|opd date)\s*[:\-].*$", re.I | re.M)
CYCLE = re.compile(r"\bcycle\s*#?\s*(?P<n>\d{1,2})(?:\s*(?:of|/)\s*(?P<of>\d{1,2}))?\b|\bC(?P<c>\d{1,2})\s*D\d{1,2}\b", re.I)


def _day(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=UTC)).date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def last_visit(
    consultations: list[dict[str, Any]], events: list[dict[str, Any]], pages: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """The point "since last visit" is measured from: the latest approved consultation recorded in
    OncoReady, else the latest clinic visit in the records (a dated consult entry, or a page that
    states its visit date). None: no earlier visit."""
    approved = [c for c in consultations if c.get("approved_at")]
    if approved:
        c = max(approved, key=lambda c: c["approved_at"])
        return {"date": _day(c["approved_at"]), "basis": "consultation", "source": None}
    visits = [(_day(e["event_date"]), e["source"]) for e in events if e["category"] == "consult" and e["event_date"] is not None]
    visits += [(_day(p["date"]), p["visit_source"]) for p in pages or [] if p.get("visit_source") and p.get("date")]
    if visits:
        when, source = max(visits, key=lambda v: v[0])
        return {"date": when, "basis": "record", "source": source}
    return None


def with_page_dates(undated: list[dict[str, Any]], pages: list[dict[str, Any]]) -> tuple[list, list]:
    """Facts with no date of their own take their page's date (a medicine line in a dated clinic
    note), marked date_basis "document". Returns (now dated, still undated)."""
    when = {(str(p["document_id"]), p["page_number"]): p.get("date") for p in pages}
    dated, still = [], []
    for e in undated:
        d = when.get((str(e["source"]["document_id"]), e["source"]["page_number"]))
        if d:
            dated.append({**e, "event_date": d, "date_basis": "document"})
        else:
            still.append(e)
    return dated, still


def _after(d: Any, since: date | None) -> bool:
    return since is None or (_day(d) is not None and _day(d) > since)


def lab_changes(labs: list[dict[str, Any]], since: date | None) -> list[dict[str, Any]]:
    """Each measured quantity with a value after the last visit: the last value on or before the
    visit (if any) and the latest one after it, both with their sources."""
    out = []
    for s in labs:
        before = [p for p in s["points"] if not _after(p["date"], since)]
        after = [p for p in s["points"] if _after(p["date"], since)]
        if not after:
            continue
        out.append({"label": s["label"], "unit": s["unit"], "before": before[-1] if before else None,
                    "after": after[-1], "readings_since": len(after)})
    return out


def medicine_changes(medicines: list[dict[str, Any]], since: date | None) -> list[dict[str, Any]]:
    """Medicines whose records changed after the last visit: first seen since then ("new"), or a
    dose written differently from the last one before ("dose"). Nothing is said about stopping:
    a medicine missing from a later note may simply not have been written down."""
    out = []
    for m in medicines:
        dated = [e for e in m["entries"] if e["date"] is not None]
        before = [e for e in dated if not _after(e["date"], since)]
        after = [e for e in dated if _after(e["date"], since)]
        if not after:
            continue
        last_before = next((e for e in reversed(before) if e["dose"] is not None), None)
        last_after = next((e for e in reversed(after) if e["dose"] is not None), after[-1])
        if not before:
            out.append({"drug": m["drug"], "change": "new", "before": None, "after": last_after})
        elif last_before and last_after["dose"] is not None and (
            (last_before["dose"], last_before["unit"]) != (last_after["dose"], last_after["unit"])
        ):
            out.append({"drug": m["drug"], "change": "dose", "before": last_before, "after": last_after})
    return out


def _fact(f: dict[str, Any], session: dict[str, Any]) -> dict[str, Any]:
    return {"label": f["label"], "quote": f["quote"], "urgent": f["urgent"], "details": f["details"],
            "session_id": session["session_id"], "turn_index": f["turn_index"], "ended_at": session["ended_at"]}


def patient_reports(history: list[dict[str, Any]], since: date | None) -> dict[str, Any]:
    """What the patient told Ritu after the last visit (newest first): symptoms, hospital visits,
    and medicines, each in their own words."""
    sessions = [s for s in history if _after(s["ended_at"], since)]
    pick = lambda key: [_fact(f, s) for s in sessions for sec in s["sections"] if sec["section"] == key for f in sec["facts"]]
    return {
        "conversations": len(sessions),
        "symptoms": pick("current_symptom"),
        "hospital_visits": pick("recent_care"),
        "medicines": pick("medication") + pick("treatment"),
    }


def _record_tests(events: list[dict[str, Any]], records: list[dict[str, Any]]) -> set[str]:
    tests: set[str] = set()
    for e in events:
        p = e["payload"] or {}
        tests |= canonical_tests(p.get("test_name"), e["description"])
    for r in records:
        tests |= canonical_tests(r["filename"].replace("_", " "))
    return tests


def missing(
    history: list[dict[str, Any]], events: list[dict[str, Any]], undated: list[dict[str, Any]],
    records: list[dict[str, Any]], medicines: list[dict[str, Any]], pages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """What the doctor may not have: records the patient mentioned that are not uploaded, medicines
    the patient takes that no record names, pages that could not be read well, facts with no
    readable date, and records that failed to process. Each item says why it is listed."""
    out: list[dict[str, Any]] = []
    have = _record_tests(events + undated, records)
    seen_tests: set[str] = set()
    for s in history:  # newest first: the patient's latest words lead
        for sec in s["sections"]:
            if sec["section"] != "previous_record":
                continue
            for f in sec["facts"]:
                d = f["details"]
                tests = canonical_tests(f["label"], d.get("record_type"))
                gone = sorted(t for t in tests - have if t not in seen_tests)
                if not gone:
                    continue
                seen_tests.update(gone)
                out.append({"kind": "record_not_uploaded", "tests": gone, "record_date": d.get("record_date"),
                            "facility": d.get("facility"), **_fact(f, s)})
    record_drugs = [m["drug"].lower() for m in medicines]
    named: set[str] = set()
    for s in history:
        for sec in s["sections"]:
            if sec["section"] != "medication":
                continue
            for f in sec["facts"]:
                label = f["label"].lower()
                if label in named or any(fuzz.partial_ratio(d, label) >= DRUG_MATCH for d in record_drugs):
                    continue
                named.add(label)
                out.append({"kind": "medicine_not_in_records", **_fact(f, s)})
    for p in pages:
        if p["confidence"] is not None and p["confidence"] < LOW_OCR_CONFIDENCE:
            out.append({"kind": "page_hard_to_read", "filename": p["filename"], "document_id": p["document_id"],
                        "page_number": p["page_number"], "confidence": round(p["confidence"], 2)})
    _, no_date = with_page_dates(undated, pages)  # a fact on a dated page has that date
    if no_date:
        out.append({"kind": "facts_without_date", "count": len(no_date)})
    for r in records:
        if r["status"] == "failed":
            out.append({"kind": "record_failed", "filename": r["filename"], "document_id": r["id"], "error": r["error"]})
    return out


def _event(e: dict[str, Any], label: str, **extra: Any) -> dict[str, Any]:
    return {"label": label, "date": e["event_date"], "description": e["description"], "source": e["source"], **extra}


def milestones(events: list[dict[str, Any]], page_lines: list[dict[str, Any]] = ()) -> list[dict[str, Any]]:
    """Where the patient is in their care, as the records state it: first pathology report, first
    and latest treatment (with the cycle number when the record writes one), procedures, and the
    latest imaging and response assessment. Oldest first. The cycle number is read from treatment
    lines, clinic notes and the record pages' own lines that state one (page_lines: dated, with
    their source), since the extractor can leave "Cycle 6 of 6." out."""
    # an order is not a milestone: "CT chest ordered" is not a scan that was done
    dated = sorted((e for e in events if e["event_date"] is not None and (e["payload"] or {}).get("kind") != "test_ordered"),
                   key=lambda e: _day(e["event_date"]))
    by = lambda pred: [e for e in dated if pred(e)]
    out = []
    path = by(lambda e: e["category"] == "pathology")
    if path:
        out.append(_event(path[0], "First pathology report"))
    treat = by(lambda e: e["category"] == "treatment" or (e["payload"] or {}).get("kind") == "treatment")
    if treat:
        out.append(_event(treat[0], "First treatment in the records"))  # may not be the first ever
        # the cycle is often written in the clinic note ("cycle 3 of 6 given"), not only in a treatment line
        noted = by(lambda e: e in treat or e["category"] == "consult")
        cycles = [(e, CYCLE.search(f"{e['description'] or ''} {e['source']['text_span']}")) for e in noted]
        cycles = [(e, m) for e, m in cycles if m]
        cycles += [(ln, CYCLE.search(ln["description"])) for ln in page_lines if ln["event_date"] is not None]
        if cycles:
            # the latest date; on one date, the highest cycle written
            e, m = max(cycles, key=lambda c: (_day(c[0]["event_date"]), int(c[1]["n"] or c[1]["c"])))
            out.append(_event(e, "Latest cycle", cycle=int(m["n"] or m["c"]), of=int(m["of"]) if m["of"] else None))
        elif treat[-1] is not treat[0]:
            out.append(_event(treat[-1], "Latest treatment"))
    for e in by(lambda e: e["category"] == "procedure"):
        if path and _day(e["event_date"]) == _day(path[0]["event_date"]):
            continue  # the biopsy behind the first pathology report: already listed
        out.append(_event(e, "Procedure"))
    for label, pred in (("Latest imaging", lambda e: e["category"] == "imaging"),
                        ("Latest response assessment", lambda e: (e["payload"] or {}).get("kind") == "response_assessment")):
        hits = by(pred)
        if hits:
            out.append(_event(hits[-1], label))
    out.sort(key=lambda m: _day(m["date"]))
    return out


def readiness(
    *, timeline: dict[str, Any], medicines: list[dict[str, Any]], labs: list[dict[str, Any]],
    history: list[dict[str, Any]], records: list[dict[str, Any]], consultations: list[dict[str, Any]],
    pages: list[dict[str, Any]],
) -> dict[str, Any]:
    events, undated = timeline["events"], timeline["date_unclear"]["events"]
    page_dated, _ = with_page_dates(undated, pages)
    dated = sorted(events + page_dated, key=lambda e: _day(e["event_date"]))
    visit = last_visit(consultations, dated, pages)
    since = visit["date"] if visit else None
    by_id = {str(e["id"]): e for e in events + undated}
    return {
        "last_visit": visit,
        # No earlier visit: there is nothing to compare with, so no "changes" (the rest still applies).
        "changes": {
            "new_records": [r for r in records if _after(r["uploaded_at"], since)],
            # measured values and medicines have their own lists (before -> after)
            "events": [e for e in reversed(dated) if _after(e["event_date"], since)
                       and (e["payload"] or {}).get("value") is None and not (e["payload"] or {}).get("drug")],
            "labs": lab_changes(labs, since),
            "medicines": medicine_changes(medicines, since),
            "patient": patient_reports(history, since),
        } if visit else None,
        "pending_tests": timeline["pending_tests"],
        "inconsistent": [
            {**d, "events": [by_id[str(i)] for i in d["event_ids"] if str(i) in by_id]} for d in timeline["discrepancies"]
        ],
        "missing": missing(history, events, undated, records, medicines, pages),
        "milestones": milestones(dated, [
            {"event_date": p["date"], "description": s["text_span"], "source": s}
            for p in pages if p.get("date") for s in p.get("cycle_sources", [])
        ]),
    }


def case_readiness(
    db: Session, org_id: uuid.UUID, case_id: uuid.UUID, *, timeline: dict[str, Any], medicines: list[dict[str, Any]],
    labs: list[dict[str, Any]], history: list[dict[str, Any]], records: list[dict[str, Any]],
) -> dict[str, Any]:
    names = {r["id"]: r["filename"] for r in records}
    rows = DocumentPageRepository(db, org_id).for_case(case_id)
    order = document_orders(rows)
    pages = []
    for p in rows:
        line = VISIT_LINE.search(p.ocr_text)
        link = f"/documents/{p.document_id}/pages/{p.page_number}"
        pages.append({
            "document_id": p.document_id, "filename": names.get(p.document_id), "page_number": p.page_number,
            "confidence": p.confidence, "date": page_date(p.ocr_text, order[p.document_id]),
            "visit_source": {"document_id": p.document_id, "filename": names.get(p.document_id), "page_number": p.page_number,
                             "page_url": link, "image_url": f"{link}/image", "text_span": line.group(0).strip()} if line else None,
            "cycle_sources": [
                {"document_id": p.document_id, "filename": names.get(p.document_id), "page_number": p.page_number,
                 "page_url": link, "image_url": f"{link}/image", "text_span": ln.strip()}
                for ln in p.ocr_text.splitlines() if CYCLE.search(ln)
            ],
        })
    consultations = [{"approved_at": c.approved_at} for c in ConsultationRepository(db, org_id).approved_for_case(case_id)]
    return readiness(timeline=timeline, medicines=medicines, labs=labs, history=history, records=records,
                     consultations=consultations, pages=pages)
