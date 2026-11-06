from datetime import date

import pytest

from app.pipeline.dates import MONTH_FIRST, page_date, parse_date, resolve_event_date, slash_order


@pytest.mark.parametrize(
    "text, expected",
    [
        ("2026-01-15", (date(2026, 1, 15), "exact")),
        ("sent 2026-01-15, result pending", (date(2026, 1, 15), "exact")),
        ("01/09/2026", (date(2026, 9, 1), "exact")),  # day-first: 1 Sep, as Indian records write it
        ("13/10/2026", (date(2026, 10, 13), "exact")),
        ("2 Feb 2026", (date(2026, 2, 2), "exact")),
        ("June 9, 2025", (date(2025, 6, 9), "exact")),
        ("November 2025", (date(2025, 11, 1), "month")),
        ("Oct. 2025", (date(2025, 10, 1), "month")),
        ("06/2015", (date(2015, 6, 1), "month")),
        ("2024", (date(2024, 1, 1), "year")),
        ("date not documented", (None, "unknown")),
        (None, (None, "unknown")),
    ],
)
def test_parse_date(text, expected):
    assert parse_date(text) == expected


def test_relative_dates_inherit_page_date_as_inferred():
    page = "TTE REPORT\nStudy date: 08/09/2025\nLVEF 48%."
    assert page_date(page) == date(2025, 9, 8)
    assert resolve_event_date("same day", page) == (date(2025, 9, 8), "inferred")
    assert resolve_event_date("today", "no header here") == (None, "unknown")
    assert resolve_event_date(None, page) == (None, "unknown")  # never borrow the note date silently


def test_slash_dates_follow_the_page():
    # Day-first unless the page's own slash dates can only be month-first (a US-style report).
    assert slash_order("Date of service: 05/11/2026") == "dmy"
    assert slash_order("Date of service: 20/07/2026") == "dmy"
    assert slash_order("Date of service: 07/20/2026\nHb 11.8 (07/18/2026)") == MONTH_FIRST
    assert slash_order("seen 07/20/2026, again 20/07/2026") == "dmy"  # mixed: keep the default
    assert parse_date("07/20/2026", MONTH_FIRST) == (date(2026, 7, 20), "exact")
    assert parse_date("07/20/2026") == (date(2026, 1, 1), "year")  # no month 20: only the year is certain
    us = "Date of service: 10/15/2026\nHemoglobin: 10.2 g/dL (10/13/2026)."
    assert page_date(us) == date(2026, 10, 15)
    assert resolve_event_date("10/13/2026", us) == (date(2026, 10, 13), "exact")
    indian = "Date of service: 05/11/2026\nHb 9.8 g/dL on 03/11/2026"
    assert page_date(indian) == date(2026, 11, 5)
    assert resolve_event_date("03/11/2026", indian) == (date(2026, 11, 3), "exact")
