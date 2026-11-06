"""Medicines and lab results from the patient's records, over time, for the doctor's graphs and
the summary. Read in code from validated timeline events (each with its source page); nothing is
inferred. Drug interactions are not checked here: that needs a licensed, clinically reviewed drug
database, and the product does not give treatment advice (CLAUDE.md rule 2)."""

import re
import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.assistant.measures import quantity_for_analyte
from app.pipeline.dates import document_orders, page_date
from app.repositories.cases import DocumentPageRepository
from app.services.timeline import build_timeline


def _key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


def _dated(timeline: dict[str, Any], page_dates: dict[tuple, Any]):
    """Every event with a date: its own, else the date of the record page it is on (e.g. a medicine
    list in a dated clinic note), labelled as such."""
    for e in [*timeline["events"], *timeline["date_unclear"]["events"]]:
        if e["event_date"] is not None:
            yield e, e["event_date"], "stated"
        else:
            src = e["source"]
            when = page_dates.get((src["document_id"], src["page_number"]))
            yield e, when, "document" if when else None


def medicines(timeline: dict[str, Any], page_dates: dict[tuple, Any] | None = None) -> list[dict[str, Any]]:
    """Each drug named in the records with every dose given for it, oldest first."""
    drugs: dict[str, dict[str, Any]] = {}
    for e, when, basis in _dated(timeline, page_dates or {}):
        p = e["payload"] or {}
        if not p.get("drug"):
            continue
        d = drugs.setdefault(_key(p["drug"]), {"drug": p["drug"], "entries": []})
        d["entries"].append({
            "date": when, "date_basis": basis, "dose": p.get("dose"), "unit": p.get("dose_unit"),
            "frequency": p.get("frequency"), "description": e["description"], "source": e["source"],
        })
    for d in drugs.values():
        d["entries"].sort(key=lambda x: (x["date"] is None, x["date"] or ""))
        d["latest"] = next((x for x in reversed(d["entries"]) if x["dose"] is not None), None)
    return sorted(drugs.values(), key=lambda d: d["drug"].lower())


def lab_series(timeline: dict[str, Any], page_dates: dict[tuple, Any] | None = None) -> list[dict[str, Any]]:
    """Each measured quantity (LVEF, hemoglobin, ...) with its dated values, oldest first. One unit
    per quantity; values are as written in the records."""
    series: dict[str, dict[str, Any]] = {}
    for e, when, basis in _dated(timeline, page_dates or {}):
        p = e["payload"] or {}
        if when is None:
            continue
        if p.get("value") is None or not (p.get("analyte") or p.get("analyte_text")):
            continue
        q = quantity_for_analyte(p.get("analyte_text") or p.get("analyte"))
        if q and q.key == "blood_pressure":
            continue  # two numbers (124/78): not one line on a graph; the records assistant answers it
        key = q.key if q else _key(p.get("analyte") or p["analyte_text"])
        label = q.label if q else (p.get("analyte_text") or p["analyte"])
        s = series.setdefault(key, {"key": key, "label": label, "unit": p.get("unit"), "points": []})
        if (p.get("unit") or None) != (s["unit"] or None) and s["points"]:
            continue  # a different unit: not on the same graph
        s["points"].append({"date": when, "date_basis": basis, "value": p["value"], "source": e["source"]})
    for s in series.values():
        s["points"].sort(key=lambda x: x["date"])
        seen = set()  # one value per date (the first in the records)
        s["points"] = [pt for pt in s["points"] if not (pt["date"] in seen or seen.add(pt["date"]))]
    return sorted(series.values(), key=lambda s: (-len(s["points"]), s["label"].lower()))


def record_trends(db: Session, org_id: uuid.UUID, case_id: uuid.UUID, timeline: dict[str, Any] | None = None) -> dict[str, Any]:
    timeline = timeline or build_timeline(db, org_id, case_id)
    pages = DocumentPageRepository(db, org_id).for_case(case_id)
    order = document_orders(pages)
    page_dates = {(p.document_id, p.page_number): page_date(p.ocr_text, order[p.document_id]) for p in pages}
    page_dates = {k: v for k, v in page_dates.items() if v}
    return {"medicines": medicines(timeline, page_dates), "labs": lab_series(timeline, page_dates)}
