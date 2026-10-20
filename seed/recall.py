"""Extraction recall per case against seed/cases/*/answer_key.json (demo org).

    cd backend && DATABASE_URL=... .venv/bin/python ../seed/recall.py
    docker compose exec backend python /seed/recall.py

An expected fact counts as recalled when an accepted timeline event on the same document page
has a span that fuzzy-matches the expected span (rapidfuzz partial ratio >= 0.85). "+date" also
requires the parsed date to equal the expected date (or an allowed alternative).
"OCR ceiling" = expected spans that are findable in the page's OCR text at all.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
for candidate in (HERE.parent / "backend", Path("/app")):
    if (candidate / "app").is_dir():
        sys.path.insert(0, str(candidate))
        break

from rapidfuzz import fuzz  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.pipeline.derive import facts_for_case, lab_flags  # noqa: E402
from app.pipeline.extraction import align_span  # noqa: E402
from app.repositories.cases import CaseRepository, DocumentPageRepository, SourceDocumentRepository  # noqa: E402
from app.repositories.orgs import OrgRepository  # noqa: E402
from app.repositories.timeline import (  # noqa: E402
    DiscrepancyRepository,
    PendingTestRepository,
    RejectedExtractionRepository,
    TimelineEventRepository,
)

THRESHOLD = 0.85


def pct(n: int, d: int) -> str:
    return f"{n}/{d} ({100 * n / d:.0f}%)" if d else "n/a"


def evaluate(db, org_id, case, key) -> dict:
    docs = {d.filename: d for d in SourceDocumentRepository(db, org_id).for_case(case.id)}
    pages = {(p.document_id, p.page_number): p for p in DocumentPageRepository(db, org_id).for_case(case.id)}
    events = TimelineEventRepository(db, org_id).for_case(case.id)
    by_page: dict = {}
    for e in events:
        by_page.setdefault(e.source_page_id, []).append(e)

    ocr_ok = span_ok = date_ok = cat_ok = 0
    matched_ids, misses = set(), []
    for exp in key["events"]:
        doc = docs.get(exp["document"])
        page = pages.get((doc.id, exp["page"])) if doc else None
        if page is None:
            misses.append(f"{exp['id']}: page not OCR'd")
            continue
        if align_span(exp["span"], page.ocr_text)[0] >= THRESHOLD:
            ocr_ok += 1
        cands = [
            e for e in by_page.get(page.id, [])
            if fuzz.partial_ratio(exp["span"].lower(), e.source_text_span.lower()) / 100 >= THRESHOLD
        ]
        if not cands:
            misses.append(f"{exp['id']}: not extracted ({exp['fact']})")
            continue
        span_ok += 1
        matched_ids.update(e.id for e in cands)
        allowed = {exp["date"], *exp.get("alt_dates", [])}
        if any((e.event_date.isoformat() if e.event_date else None) in allowed for e in cands):
            date_ok += 1
        else:
            got = sorted({str(e.event_date) for e in cands})
            misses.append(f"{exp['id']}: date {got} != {exp['date']}")
        if any(e.category == exp["category"] for e in cands):
            cat_ok += 1

    pending = {t.test_name for t in PendingTestRepository(db, org_id).for_case(case.id)}
    discs = {d.field for d in DiscrepancyRepository(db, org_id).for_case(case.id)}
    flags = lab_flags(facts_for_case(db, org_id, case.id))
    exp_pending = {p["test"] for p in key["pending_tests"]}
    exp_discs = {x["analyte"] for x in key["discrepancies"]}
    flag_hits = sum(
        any(f["rule"] == x["rule"] and f["from_value"] == x["from"] and f["to_value"] == x["to"] for f in flags)
        for x in key["flags"]
    )
    misses += [f"pending test missing: {t}" for t in sorted(exp_pending - pending)]
    misses += [f"discrepancy missing: {a}" for a in sorted(exp_discs - discs)]
    extra_pending = sorted(pending - exp_pending)
    extra_discs = sorted(discs - exp_discs)
    n_pages = len(pages)
    return {
        "case": case.case_code,
        "doc_status": sorted({d.status for d in docs.values()}),
        "doc_errors": sorted({d.error for d in docs.values() if d.error}),
        "ocr_conf": round(sum(p.confidence or 0 for p in pages.values()) / n_pages, 3) if n_pages else None,
        "ocr_engines": sorted({p.ocr_engine for p in pages.values()}),
        "expected": len(key["events"]),
        "ocr_ceiling": ocr_ok,
        "recall_span": span_ok,
        "recall_span_date": date_ok,
        "category_agree": cat_ok,
        "extracted": len(events),
        "unmatched_extracted": len([e for e in events if e.id not in matched_ids]),
        "rejected": len(RejectedExtractionRepository(db, org_id).for_case(case.id)),
        "pending": (len(exp_pending & pending), len(exp_pending), extra_pending),
        "discrepancies": (len(exp_discs & discs), len(exp_discs), extra_discs),
        "flags": (flag_hits, len(key["flags"]), len(flags)),
        "misses": misses,
    }


def main() -> None:
    results = []
    with SessionLocal() as db:
        org = OrgRepository(db).get_by_slug("demo")
        if org is None:
            sys.exit("demo org not found; run seed.py first")
        cases = CaseRepository(db, org.id)
        for case_dir in sorted(p for p in (HERE / "cases").iterdir() if (p / "answer_key.json").exists()):
            key = json.loads((case_dir / "answer_key.json").read_text())
            case = cases.list(cases.model.case_code == key["case_code"])
            if case:
                results.append(evaluate(db, org.id, case[0], key))

    print("| Case | OCR conf | OCR ceiling | Recall (span) | Recall (span+date) | Category agrees | Extracted / unmatched / rejected | Pending tests | Discrepancies | Flags |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    tot = {k: 0 for k in ("expected", "ocr_ceiling", "recall_span", "recall_span_date", "category_agree")}
    for r in results:
        for k in tot:
            tot[k] += r[k]
        print(
            f"| {r['case']} | {r['ocr_conf']} ({'/'.join(r['ocr_engines'])}) | {pct(r['ocr_ceiling'], r['expected'])} "
            f"| {pct(r['recall_span'], r['expected'])} | {pct(r['recall_span_date'], r['expected'])} "
            f"| {pct(r['category_agree'], r['recall_span'])} "
            f"| {r['extracted']} / {r['unmatched_extracted']} / {r['rejected']} "
            f"| {pct(*r['pending'][:2])}{' +' + ','.join(r['pending'][2]) if r['pending'][2] else ''} "
            f"| {pct(*r['discrepancies'][:2])}{' +' + ','.join(r['discrepancies'][2]) if r['discrepancies'][2] else ''} "
            f"| {pct(*r['flags'][:2])} |"
        )
    print(
        f"| **All** | | {pct(tot['ocr_ceiling'], tot['expected'])} | {pct(tot['recall_span'], tot['expected'])} "
        f"| {pct(tot['recall_span_date'], tot['expected'])} | {pct(tot['category_agree'], tot['recall_span'])} | | | | |"
    )
    for r in results:
        if r["doc_errors"]:
            print(f"\n{r['case']} document errors: {r['doc_errors']}")
        if r["misses"]:
            print(f"\n{r['case']} misses:\n  " + "\n  ".join(r["misses"]))


if __name__ == "__main__":
    main()
