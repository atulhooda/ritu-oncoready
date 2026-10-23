"""Measurements, read in code from verbatim record text: which quantity a phrase names, and the
value and unit stated after it. No LLM. Used both for the doctor's question ("pulse three months
ago") and for record lines ("Vitals: pulse rate 80 bpm; blood pressure 124/78 mmHg")."""

import re
from dataclasses import dataclass

from app.pipeline.derive import canonical_analyte


@dataclass(frozen=True)
class Quantity:
    key: str
    label: str
    pattern: str  # names the quantity
    default_unit: str | None


QUANTITIES = [
    Quantity("pulse_rate", "pulse rate", r"\bpulse(?: rate)?\b|\bheart rate\b|\bhr\b", "bpm"),
    Quantity("blood_pressure", "blood pressure", r"\bblood pressure\b|\bbp\b", "mmHg"),
    Quantity("temperature", "temperature", r"\btemp(?:erature)?\b", None),
    Quantity("weight", "weight", r"\b(?:body )?weight\b|\bwt\b", "kg"),
    Quantity("hemoglobin", "hemoglobin", r"\bha?emoglobin\b|\bhgb\b|\bhb\b", "g/dL"),
    Quantity("spo2", "oxygen saturation", r"\bspo2\b|\boxygen saturation\b|\bo2 sat", "%"),
    Quantity("lvef", "LVEF", r"\blvef\b|\bejection fraction\b", "%"),
]
BY_KEY = {q.key: q for q in QUANTITIES}

_NUMBER = r"(?P<v>\d{2,3}\s*/\s*\d{2,3}|\d+(?:\.\d+)?)"
_UNIT = r"\s*(?P<u>bpm|beats/min|/min|mm ?hg|°\s*[cf]|deg(?:rees)? ?[cf]|[cf]\b|kg|kgs|lb|lbs|g/dl|gm/dl|g/l|%)?"


def quantity_in(text: str) -> Quantity | None:
    """The first known quantity a phrase names (the doctor's question, or a record's analyte)."""
    low = text.lower()
    hits = [(m.start(), q) for q in QUANTITIES if (m := re.search(q.pattern, low))]
    return min(hits, key=lambda h: h[0])[1] if hits else None


def quantity_for_analyte(analyte: str | None) -> Quantity | None:
    """Map an extracted analyte ("Pulse", "Hb", "ejection fraction") to a known quantity."""
    if not analyte:
        return None
    q = quantity_in(analyte)
    if q:
        return q
    key = canonical_analyte(analyte)
    return BY_KEY.get(key or "")


def normalize_unit(unit: str | None, q: Quantity) -> str | None:
    u = (unit or "").strip().lower().replace(" ", "")
    if not u:
        return q.default_unit
    if u in ("bpm", "beats/min", "/min"):
        return "bpm"
    if u == "mmhg":
        return "mmHg"
    if u in ("kg", "kgs"):
        return "kg"
    if u in ("lb", "lbs"):
        return "lb"
    if u in ("g/dl", "gm/dl"):
        return "g/dL"
    if u == "g/l":
        return "g/L"
    if u.endswith("c"):
        return "°C"
    if u.endswith("f"):
        return "°F"
    return unit.strip()


def temperature_unit(value: float) -> str:
    return "°F" if value > 50 else "°C"


@dataclass(frozen=True)
class Reading:
    quantity: Quantity
    value: str  # as written, e.g. "80", "124/78", "98.4"
    unit: str | None
    phrase: str  # the verbatim text it was read from

    def number(self) -> float | None:
        return None if "/" in self.value else float(self.value)


def readings_in(line: str) -> list[Reading]:
    """Every "<quantity> ... <value> <unit>" in a line of record text, in order."""
    out = []
    for segment in re.split(r"[;,]|\.\s", line):
        q = quantity_in(segment)
        if q is None:
            continue
        m = re.search(q.pattern, segment.lower())
        rest = segment[m.end():]
        num = re.search(rf"^[^0-9]{{0,25}}?{_NUMBER}{_UNIT}", rest, re.I)
        if not num:
            continue
        value = re.sub(r"\s+", "", num.group("v"))
        if ("/" in value) != (q.key == "blood_pressure"):
            continue  # "124/78" is only a blood pressure
        unit = normalize_unit(num.group("u"), q)
        if q.key == "temperature" and not num.group("u"):
            unit = temperature_unit(float(value))
        phrase = segment[m.start(): m.end() + num.end()].strip()
        out.append(Reading(q, value, unit, phrase))
    return out
