"""Deterministic date parsing. The LLM only copies date text; code decides what it means.

Numeric slash dates are read as US MM/DD/YYYY. Month- and year-only dates are stored as the
first day of the period with precision 'month' / 'year'.
"""

import re
from datetime import date

MONTHS = {
    m: i
    for i, names in enumerate(
        [("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april"), ("may",),
         ("jun", "june"), ("jul", "july"), ("aug", "august"), ("sep", "sept", "september"),
         ("oct", "october"), ("nov", "november"), ("dec", "december")],
        start=1,
    )
    for m in names
}
_MON = r"(?P<mon>" + "|".join(sorted(MONTHS, key=len, reverse=True)) + r")\.?"
_Y = r"(?P<y>(?:19|20)\d{2})"

# (pattern, precision) in priority order; each must define y, and m/mon, and d where relevant.
PATTERNS = [
    (rf"\b{_Y}-(?P<m>\d{{1,2}})-(?P<d>\d{{1,2}})\b", "exact"),
    (rf"\b(?P<m>\d{{1,2}})/(?P<d>\d{{1,2}})/{_Y}\b", "exact"),
    (rf"\b(?P<d>\d{{1,2}})\s+{_MON}\s+{_Y}\b", "exact"),
    (rf"\b{_MON}\s+(?P<d>\d{{1,2}}),?\s+{_Y}\b", "exact"),
    (rf"\b{_MON},?\s+{_Y}\b", "month"),
    (rf"\b(?P<m>\d{{1,2}})/{_Y}\b", "month"),
    (rf"\b{_Y}-(?P<m>\d{{1,2}})\b", "month"),
    (rf"\b{_Y}\b", "year"),
]
RELATIVE = re.compile(r"\b(today|same day|same visit|this visit|at this visit|current visit)\b", re.I)
PAGE_DATE_LABEL = re.compile(
    r"(date of service|exam date|study date|procedure date|visit date|report date)\s*[:\-]\s*(?P<v>.+)", re.I
)


def parse_date(text: str | None) -> tuple[date | None, str]:
    """Return (date, precision) for the first date found in `text`, else (None, 'unknown')."""
    if not text:
        return None, "unknown"
    for pattern, precision in PATTERNS:
        for m in re.finditer(pattern, text, re.I):
            g = m.groupdict()
            month = MONTHS[g["mon"].lower()] if g.get("mon") else int(g.get("m") or 1)
            day = int(g.get("d") or 1)
            try:
                return date(int(g["y"]), month, day), precision
            except ValueError:
                continue  # e.g. 13/45/2026: try the next match
    return None, "unknown"


def page_date(page_text: str) -> date | None:
    """The page's own date (date of service / exam date ...), if it states exactly one kind."""
    for line in page_text.splitlines():
        m = PAGE_DATE_LABEL.search(line)
        if m:
            d, precision = parse_date(m.group("v"))
            if precision == "exact":
                return d
    return None


def resolve_event_date(date_text: str | None, page_text: str) -> tuple[date | None, str]:
    """Explicit dates win; relative phrases ('today', 'same day') take the page's date as 'inferred'."""
    d, precision = parse_date(date_text)
    if d is not None:
        return d, precision
    if date_text and RELATIVE.search(date_text):
        pd = page_date(page_text)
        if pd is not None:
            return pd, "inferred"
    return None, "unknown"
