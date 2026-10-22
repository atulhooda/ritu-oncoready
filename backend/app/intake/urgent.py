"""Patient-reported items on a fixed list of urgent signs. Matched in code (never by the LLM) on the
fact's English label and details, so the doctor's report, the patient list and the patient's own
screen all agree. Keep in step with the safety rule in app/voice/script.py; clinically reviewed list."""

import re
from typing import Any

URGENT = [
    re.compile(p, re.I)
    for p in (
        r"\bcough\w*( up| with)? blood|\bblood in (the )?(stool|urine|vomit|sputum|cough)|\bvomit\w* blood|\bblack stool|\bbleed",
        r"\bfever|\bchills",
        r"\bchest pain",
        r"\bconfus|\bfaint|\bseizure|\bfits\b",
        r"\bsuicid|\bself[- ]?harm|\bharm (my|them)sel",
        r"\bcan'?t breathe|\bsevere(ly)? (short(ness)? of )?breath",
    )
]


def is_urgent(label: str, details: dict[str, Any] | None = None) -> bool:
    values = [v for k, v in (details or {}).items() if k != "evidence" and isinstance(v, str)]
    text = " ".join([label, *values])
    return any(p.search(text) for p in URGENT)
