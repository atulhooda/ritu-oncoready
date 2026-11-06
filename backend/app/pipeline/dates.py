"""Deterministic date parsing. The LLM only copies date text; code decides what it means.

Numeric slash dates are read day-first (DD/MM/YYYY), as Indian records write them. A page whose own
slash dates can only be month-first (07/20/2026, and none like 20/07/2026) is read month-first, so
a US-style report still lands on the right day. Month- and year-only dates are stored as the first
day of the period with precision 'month' / 'year'.
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

_SLASH = rf"\b(?P<a>\d{{1,2}})/(?P<b>\d{{1,2}})/{_Y}\b"
DAY_FIRST, MONTH_FIRST = "dmy", "mdy"

# (pattern, precision) in priority order; each must define y, and m/mon, and d where relevant.
# The slash pattern is filled in by slash order (see _patterns).
PATTERNS = [
    (rf"\b{_Y}-(?P<m>\d{{1,2}})-(?P<d>\d{{1,2}})\b", "exact"),
    (None, "exact"),
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


def _patterns(order: str) -> list[tuple[str, str]]:
    first, second = ("d", "m") if order == DAY_FIRST else ("m", "d")
    slash = rf"\b(?P<{first}>\d{{1,2}})/(?P<{second}>\d{{1,2}})/{_Y}\b"
    return [(p or slash, precision) for p, precision in PATTERNS]


def slash_order(text: str | None) -> str:
    """Month-first only when the slash dates in `text` can only be read that way; else day-first.
    Pass a whole document's text: its pages follow one style, and one page may have only
    ambiguous dates (01/06/2025)."""
    day_first = month_first = False
    for m in re.finditer(_SLASH, text or ""):
        a, b = int(m.group("a")), int(m.group("b"))
        day_first |= 12 < a <= 31 and b <= 12
        month_first |= 12 < b <= 31 and a <= 12
    return MONTH_FIRST if month_first and not day_first else DAY_FIRST


def document_orders(pages) -> dict:
    """Each document's slash-date order, from all of its pages together."""
    texts: dict = {}
    for p in pages:
        texts.setdefault(p.document_id, []).append(p.ocr_text)
    return {doc: slash_order("\n".join(t)) for doc, t in texts.items()}


def parse_date(text: str | None, order: str = DAY_FIRST) -> tuple[date | None, str]:
    """Return (date, precision) for the first date found in `text`, else (None, 'unknown').
    `order` is how to read 03/08/2025: DAY_FIRST (3 Aug, the default) or MONTH_FIRST."""
    if not text:
        return None, "unknown"
    for pattern, precision in _patterns(order):
        for m in re.finditer(pattern, text, re.I):
            g = m.groupdict()
            month = MONTHS[g["mon"].lower()] if g.get("mon") else int(g.get("m") or 1)
            day = int(g.get("d") or 1)
            try:
                return date(int(g["y"]), month, day), precision
            except ValueError:
                continue  # e.g. 13/45/2026: try the next match
    return None, "unknown"


def page_date(page_text: str, order: str | None = None) -> date | None:
    """The page's own date (date of service / exam date ...), if it states exactly one kind.
    `order`: the document's slash order (slash_order of all its pages); default: this page's."""
    order = order or slash_order(page_text)
    for line in page_text.splitlines():
        m = PAGE_DATE_LABEL.search(line)
        if m:
            d, precision = parse_date(m.group("v"), order)
            if precision == "exact":
                return d
    return None


def resolve_event_date(date_text: str | None, page_text: str, order: str | None = None) -> tuple[date | None, str]:
    """Explicit dates win, read in the document's slash order (default: this page's); relative
    phrases ('today', 'same day') take the page's date as 'inferred'."""
    order = order or slash_order(page_text)
    d, precision = parse_date(date_text, order)
    if d is not None:
        return d, precision
    if date_text and RELATIVE.search(date_text):
        pd = page_date(page_text, order)
        if pd is not None:
            return pd, "inferred"
    return None, "unknown"
