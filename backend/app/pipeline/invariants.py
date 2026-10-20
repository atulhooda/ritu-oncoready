"""Conflicts in fields that should not change without a documented event.

Histology, primary site, stage, and HER2/ER/PR status are compared across every pair of facts
from *different documents*, regardless of date. Values are normalized in code; the LLM only
copies the field name and its verbatim value.

Rules:
- HER2/ER/PR: "equivocal" is compatible with anything (e.g. IHC 2+ later resolved by FISH).
- Stage: only stages of the same system are compared (clinical c/unprefixed, pathologic p,
  post-therapy y). A stage change is NOT a discrepancy when a documented treatment response
  (kind "response_assessment") is dated between the two stages. Undated stages cannot be
  ordered, so they are never excused.
- Histology: only specific types are compared; generic terms (carcinoma, NSCLC) are compatible
  with their subtypes.
- Primary site: organ, laterality, and lung lobe are compared only where both facts state them.
"""

import re
from collections.abc import Callable
from typing import Any

ATTRIBUTES = [  # order matters: her2 before er
    ("her2", r"her-?2|erbb2"),
    ("er", r"\ber\b|estrogen"),
    ("pr", r"\bpr\b|progesterone"),
    ("stage", r"stag|tnm"),
    ("histology", r"histolog|tumou?r type|diagnosis|patholog"),
    ("primary_site", r"primary|site|location|laterality"),
]
LABELS = {"her2": "HER2 status", "er": "ER status", "pr": "PR status", "stage": "Stage",
          "histology": "Histology", "primary_site": "Primary site"}


def canonical_attribute(name: str | None) -> str | None:
    if not name:
        return None
    low = name.lower()
    return next((key for key, pat in ATTRIBUTES if re.search(pat, low)), None)


# --- receptors -------------------------------------------------------------------------


def normalize_receptor(attr: str, text: str) -> str | None:
    t = text.lower()
    if attr == "her2":
        if re.search(r"not amplified|non-?amplified", t):
            return "negative"
        if "amplified" in t:
            return "positive"
        m = re.search(r"\b([0-3])\s*\+", t)
        if m:
            return {"3": "positive", "2": "equivocal"}.get(m.group(1), "negative")
    if re.search(r"equivocal|borderline", t):
        return "equivocal"
    if re.search(r"negative|\bneg\b", t):
        return "negative"
    if re.search(r"\blow\b", t):
        return "low"
    if re.search(r"positive|\bpos\b", t):
        return "positive"
    return None


def receptors_conflict(a: str, b: str) -> bool:
    return "equivocal" not in (a, b) and a != b


# --- stage -----------------------------------------------------------------------------

TNM_RE = re.compile(
    # [o] accepts OCR's letter-O-for-zero ("cT1c NO MO"); normalized to 0 below.
    r"\b(?P<prefix>yp|yc|p|c|r)?T(?P<t>is|[0-4xo][a-d]?(?:mi)?)\s*N(?P<n>[0-3xo][a-c]?)\s*M(?P<m>[01xo][a-d]?)\b",
    re.I,
)
GROUP_RE = re.compile(r"\bstage\s+(?P<g>iv|i{1,3}|0|[1-4])(?P<sub>[a-c][1-3]?)?\b", re.I)
ARABIC_TO_ROMAN = {"1": "I", "2": "II", "3": "III", "4": "IV"}


def normalize_stage(text: str) -> dict[str, Any] | None:
    tnm, group = TNM_RE.search(text), GROUP_RE.search(text)
    if not tnm and not group:
        return None
    prefix = (tnm.group("prefix") or "").lower() if tnm else ""
    if not prefix and re.search(r"\bpost-?(?:therapy|treatment)|\bneoadjuvant", text, re.I):
        prefix = "y"
    system = "post_therapy" if prefix.startswith("y") else "pathologic" if prefix == "p" else "clinical"
    def part(name: str) -> str:
        v = tnm.group(name).lower()
        return v if v == "is" else "0" + v[1:] if v.startswith("o") else v

    norm_tnm = f"T{part('t')} N{part('n')} M{part('m')}" if tnm else None
    norm_group = None
    if group:
        g = group.group("g").upper()
        norm_group = ARABIC_TO_ROMAN.get(g, g) + (group.group("sub") or "").upper()
    return {"system": system, "tnm": norm_tnm, "group": norm_group}


def stages_conflict(a: dict, b: dict) -> bool:
    if a["system"] != b["system"]:
        return False
    if a["tnm"] and b["tnm"]:
        return a["tnm"] != b["tnm"]
    if a["group"] and b["group"]:
        return a["group"] != b["group"]
    return False


# --- histology -------------------------------------------------------------------------

HISTOLOGY_TYPES = [  # order matters: "non-small cell" before "small cell"
    ("nsclc", r"non[- ]?small[- ]cell|\bnsclc\b"),
    ("small_cell", r"small[- ]cell|\bsclc\b"),
    ("squamous", r"squamous"),
    ("large_cell", r"large[- ]cell"),
    ("lobular", r"lobular"),
    ("ductal", r"ductal|no special type|\bnst\b"),
    ("adenocarcinoma", r"adenocarcinoma"),
    ("neuroendocrine", r"carcinoid|neuroendocrine"),
    ("lymphoma", r"lymphoma"),
    ("sarcoma", r"sarcoma"),
    ("melanoma", r"melanoma"),
    ("mesothelioma", r"mesothelioma"),
]
COMPATIBLE_HISTOLOGY = {
    frozenset(p) for p in [
        ("nsclc", "adenocarcinoma"), ("nsclc", "squamous"), ("nsclc", "large_cell"),
        ("ductal", "adenocarcinoma"), ("lobular", "adenocarcinoma"),
    ]
}


def normalize_histology(text: str) -> str | None:
    low = text.lower()
    return next((key for key, pat in HISTOLOGY_TYPES if re.search(pat, low)), None)


def histology_conflict(a: str, b: str) -> bool:
    return a != b and frozenset((a, b)) not in COMPATIBLE_HISTOLOGY


# --- primary site ----------------------------------------------------------------------

ORGANS = ["breast", "lung", "colon", "rectum", "pancreas", "prostate", "ovary", "liver", "stomach",
          "esophagus", "kidney", "bladder", "thyroid", "skin", "brain"]
ORGAN_PATTERNS = {o: o[:5] for o in ORGANS} | {"lung": r"lung|lobe|pulmonary|bronch", "ovary": "ovar"}


def normalize_site(text: str) -> dict[str, str] | None:
    low = text.lower()
    out = {}
    abbr = re.search(r"\b([rl])([uml])l\b", low)  # RUL, LLL, ...
    if abbr:
        out |= {"organ": "lung", "laterality": "right" if abbr.group(1) == "r" else "left",
                "lobe": {"u": "upper", "m": "middle", "l": "lower"}[abbr.group(2)]}
    organ = next((o for o in ORGANS if re.search(ORGAN_PATTERNS[o], low)), None)
    if organ:
        out.setdefault("organ", organ)
    side = re.search(r"\b(left|right)\b", low)
    if side:
        out.setdefault("laterality", side.group(1))
    lobe = re.search(r"\b(upper|middle|lower)\s+lobe\b", low)
    if lobe:
        out.setdefault("lobe", lobe.group(1))
    return out or None


def sites_conflict(a: dict, b: dict) -> bool:
    return any(k in a and k in b and a[k] != b[k] for k in ("organ", "laterality", "lobe"))


# --- comparison ------------------------------------------------------------------------

NORMALIZERS: dict[str, tuple[Callable[[str], Any], Callable[[Any, Any], bool]]] = {
    "her2": (lambda t: normalize_receptor("her2", t), receptors_conflict),
    "er": (lambda t: normalize_receptor("er", t), receptors_conflict),
    "pr": (lambda t: normalize_receptor("pr", t), receptors_conflict),
    "stage": (normalize_stage, stages_conflict),
    "histology": (normalize_histology, histology_conflict),
    "primary_site": (normalize_site, sites_conflict),
}


def _excused_by_response(a, b, responses) -> bool:
    if a.event_date is None or b.event_date is None or a.event_date == b.event_date:
        return False
    first, last = sorted((a.event_date, b.event_date))
    return any(first <= r.event_date <= last for r in responses)


def invariant_conflicts(facts: list, doc_names: dict | None = None) -> list[tuple[Any, Any, str, str]]:
    """Pairs of facts from different documents whose invariant field values conflict."""
    doc_names = doc_names or {}
    responses = [f for f in facts if f.kind == "response_assessment" and f.event_date is not None]
    items = []
    for f in facts:
        attr = f.payload.get("attribute")
        raw = f.payload.get("attribute_value")
        if attr in NORMALIZERS and raw and f.document_id is not None:
            norm = NORMALIZERS[attr][0](raw)
            if norm is not None:
                items.append((f, attr, norm))
    items.sort(key=lambda it: (it[0].event_date is None, it[0].event_date or 0, str(it[0].id)))

    out, seen = [], set()
    for i, (a, attr, na) in enumerate(items):
        for b, attr_b, nb in items[i + 1 :]:
            if attr != attr_b or a.document_id == b.document_id:
                continue
            if not NORMALIZERS[attr][1](na, nb):
                continue
            if attr == "stage" and _excused_by_response(a, b, responses):
                continue
            # One discrepancy per field per document pair, even if a document states the
            # value in several facts (e.g. "cT1c N2 M0" and "stage IIIA" extracted separately).
            key = (attr, frozenset((a.document_id, b.document_id)))
            if key in seen:
                continue
            seen.add(key)
            name_a = doc_names.get(a.document_id, "document")
            name_b = doc_names.get(b.document_id, "document")
            out.append((a, b, attr,
                        f"{LABELS[attr]} differs between {name_a} ({a.payload['attribute_value']}) "
                        f"and {name_b} ({b.payload['attribute_value']}) with no documented "
                        f"{'treatment response' if attr == 'stage' else 'event'} explaining the change"))
    return out
