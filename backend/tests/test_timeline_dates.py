from datetime import date

import pytest
from sqlalchemy.exc import IntegrityError

from app.repositories.timeline import TimelineEventRepository
from tests.test_tenant_isolation import make_case


def add_event(db, tenant, case, page, event_date, precision):
    return TimelineEventRepository(db, tenant.org.id).add(
        case_id=case.id, event_date=event_date, date_precision=precision, category="lab",
        source_page_id=page.id, source_text_span="Synthetic biopsy",
    )


def test_undated_events_sort_last(db, org_a):
    case, _, page = make_case(db, org_a)
    undated = add_event(db, org_a, case, page, None, "unknown")
    later = add_event(db, org_a, case, page, date(2026, 3, 1), "month")
    earlier = add_event(db, org_a, case, page, date(2026, 1, 5), "exact")

    ordered = TimelineEventRepository(db, org_a.org.id).for_case(case.id)
    assert [e.id for e in ordered] == [earlier.id, later.id, undated.id]


@pytest.mark.parametrize(
    "event_date, precision",
    [(None, "exact"), (None, "month"), (date(2026, 1, 5), "unknown"), (date(2026, 1, 5), "approximate")],
)
def test_date_and_precision_must_agree(db, org_a, event_date, precision):
    case, _, page = make_case(db, org_a)
    with pytest.raises(IntegrityError):
        add_event(db, org_a, case, page, event_date, precision)
