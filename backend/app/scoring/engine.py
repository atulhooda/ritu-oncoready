"""Deterministic scoring. Pure function of (rubric items, match verdicts); no DB, LLM, clock,
or randomness. See BEHAVIOR_SPEC.md "Scoring" for the rules this implements.
"""

import hashlib
import json
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

ENGINE_VERSION = "score-v1"


@dataclass(frozen=True)
class RubricItemInput:
    id: str
    position: int
    category: str
    description: str
    weight: Decimal
    is_critical: bool


@dataclass(frozen=True)
class MatchInput:
    rubric_item_id: str
    matched: bool  # matcher verdict
    evidence: str | None = None
    evidence_section: str | None = None
    override_matched: bool | None = None
    override_comment: str | None = None


@dataclass(frozen=True)
class ScoreResult:
    points_earned: Decimal
    points_possible: Decimal
    critical_missed: int
    details: dict[str, Any]


def _money(d: Decimal) -> Decimal:
    return d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def score(items: list[RubricItemInput], matches: list[MatchInput]) -> ScoreResult:
    ordered = sorted(items, key=lambda i: (i.position, i.id))
    by_item = {m.rubric_item_id: m for m in matches if m.rubric_item_id in {i.id for i in items}}

    rows, earned, possible, critical_missed = [], Decimal(0), Decimal(0), 0
    by_category: dict[str, dict[str, Any]] = {}
    for item in ordered:
        m = by_item.get(item.id)
        if m is None:
            matched, source = False, "none"
        elif m.override_matched is not None:
            matched, source = m.override_matched, "override"
        else:
            matched, source = m.matched, "matcher"
        weight = _money(Decimal(item.weight))
        possible += weight
        if matched:
            earned += weight
        elif item.is_critical:
            critical_missed += 1
        cat = by_category.setdefault(
            item.category, {"possible": Decimal(0), "earned": Decimal(0), "matched": 0, "missed": 0, "critical_missed": 0}
        )
        cat["possible"] += weight
        cat["earned"] += weight if matched else 0
        cat["matched" if matched else "missed"] += 1
        cat["critical_missed"] += int(item.is_critical and not matched)
        rows.append({
            "rubric_item_id": item.id,
            "position": item.position,
            "category": item.category,
            "description": item.description,
            "weight": str(weight),
            "is_critical": item.is_critical,
            "matched": matched,
            "source": source,
            "matcher_matched": m.matched if m else None,
            "evidence": m.evidence if m and matched else None,
            "evidence_section": m.evidence_section if m and matched else None,
            "override_comment": m.override_comment if m and m.override_matched is not None else None,
        })

    percent = _money(earned * 100 / possible) if possible else Decimal("0.00")
    scoring_inputs = [
        [r["rubric_item_id"], r["weight"], r["is_critical"], r["matched"]] for r in rows
    ]
    details = {
        "engine_version": ENGINE_VERSION,
        "inputs_sha256": hashlib.sha256(json.dumps(scoring_inputs, separators=(",", ":")).encode()).hexdigest(),
        "points_earned": str(_money(earned)),
        "points_possible": str(_money(possible)),
        "percent": str(percent),
        "critical_missed": critical_missed,
        "items": rows,
        "by_category": {
            k: {**v, "possible": str(_money(v["possible"])), "earned": str(_money(v["earned"]))}
            for k, v in sorted(by_category.items())
        },
    }
    return ScoreResult(_money(earned), _money(possible), critical_missed, details)
