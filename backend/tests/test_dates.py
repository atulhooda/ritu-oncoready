from datetime import date

import pytest

from app.pipeline.dates import page_date, parse_date, resolve_event_date


@pytest.mark.parametrize(
    "text, expected",
    [
        ("2026-01-15", (date(2026, 1, 15), "exact")),
        ("sent 2026-01-15, result pending", (date(2026, 1, 15), "exact")),
        ("01/09/2026", (date(2026, 1, 9), "exact")),  # US month/day
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
    page = "TTE REPORT\nStudy date: 09/08/2025\nLVEF 48%."
    assert page_date(page) == date(2025, 9, 8)
    assert resolve_event_date("same day", page) == (date(2025, 9, 8), "inferred")
    assert resolve_event_date("today", "no header here") == (None, "unknown")
    assert resolve_event_date(None, page) == (None, "unknown")  # never borrow the note date silently
