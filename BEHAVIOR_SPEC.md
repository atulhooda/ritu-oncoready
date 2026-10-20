# OncoReady behavior spec

What the system does, stated as rules that code and tests must agree with. When behavior changes,
update this file in the same commit.

## Scoring

Implemented in `backend/app/scoring/engine.py` (rules) and `backend/app/scoring/service.py`
(loading inputs, storing results). Engine version: **`score-v1`**.

### Inputs

1. **Answer key.** The case's highest-version answer key with status `final`. Each rubric item has a
   `category`, a `description`, a `weight` (> 0, two decimals) and an `is_critical` flag.
2. **Brief.** The resident's submitted readiness brief. It has five fixed sections: key changes
   since last visit, pending investigations, discrepancies noticed, treatment history, red flags.
3. **Match verdicts.** At most one `brief_item_matches` row per rubric item. Each row has:
   - the matcher's verdict (`matched`), plus the evidence quote and its section;
   - optionally, a faculty override (`override_matched` plus a required comment).

### Matching (produces the verdicts; not part of the score arithmetic)

- An LLM proposes `(rubric item id, quote)` pairs. A proposal is accepted only if the quote
  occurs verbatim in the brief text. Whitespace differences are ignored, but case, punctuation
  and words must match exactly. The stored evidence is the brief's own text, not the LLM's copy.
- These proposals are rejected:
  - the quote is not in the brief (`quote_not_in_brief`);
  - the rubric id is unknown;
  - the proposal is malformed.

  Rejections never create a match. Rejected quotes are kept on the item's row as
  `rejected_evidence`, for faculty to see.
- If several quotes are accepted for one item, the first one is the evidence.
- A rubric item with no accepted quote has `matched = false`.
- Re-running matching updates the matcher's fields and keeps any faculty override.

### Effective verdict for each rubric item

| Situation | Effective `matched` | `source` |
|---|---|---|
| Faculty override set | `override_matched` | `override` |
| Matcher row, no override | `matched` | `matcher` |
| No row for the item | `false` | `none` |

### Arithmetic

- `points_possible` = sum of all rubric item weights.
- `points_earned` = sum of weights of items whose effective verdict is matched.
- `critical_missed` = number of items with `is_critical` whose effective verdict is not matched.
- `percent` = `points_earned × 100 / points_possible`, rounded half-up to 2 decimals. It is `0.00`
  if `points_possible` is 0.
- All arithmetic uses `Decimal`; weights are rounded half-up to 2 decimals first.
- There is no pass/fail threshold and no penalty for extra content. Critical misses are reported
  separately and do not reduce `points_earned`.

### Stored result (`scores` row)

There is one row per `(brief, answer key, engine version)`. Recomputing updates that row in place.

- Columns: `points_earned`, `points_possible`, `critical_missed`, `scoring_version` (= engine version).
- `details` fields:
  - `engine_version` and `inputs_sha256`. The hash covers `[item id, weight, is_critical, effective matched]` for each item, in rubric order.
  - `points_earned`, `points_possible` and `percent`, as decimal strings; `critical_missed`.
  - `items[]`, in rubric order (`position`, then id). Each item has:
    - `rubric_item_id`, `category`, `description`, `weight`, `is_critical`;
    - `matched`, `source`, `matcher_matched`;
    - `evidence` and `evidence_section` (only when matched);
    - `override_comment` (only when overridden).
  - `by_category{}`, with `possible`, `earned`, `matched`, `missed` and `critical_missed`.

### Determinism

- The score is a pure function of the rubric items and the effective verdicts. It does not
  depend on time, randomness, LLM calls or input order. The same input always gives the same
  `details` (including `inputs_sha256`) and the same columns.
- The LLM affects the score only through verdicts it proposes. Those verdicts are stored, so
  recomputing never calls the LLM again.

### Overrides

- Faculty (or admin) can set any item to matched or not matched. A non-empty comment is required.
- An optional evidence quote may be given. If given, it must occur in the brief, using the same
  rule as matching.
- Setting or clearing an override recomputes and stores the score immediately.
- Clearing an override restores the matcher's verdict. The override author and time are recorded.

### When a score is computed

- After the resident submits: matching runs, then scoring, as one Celery task. The brief status
  goes `submitted → scored`, or `scoring_failed` with `scoring_error`.
- After any override change.

### Versioning

Any change to these rules requires a new `ENGINE_VERSION`. Scores from older versions are kept
(the version is part of the row's identity), and faculty views read the current version.

### Related rules

- **Timeline lock:** residents cannot read a case's timeline or OCR text until their own brief
  for that case is submitted. The API enforces this with 403, not just the UI. Raw page images
  are always visible.
- **Brief editing:** a resident has one brief per case. It can be edited while it is a draft and
  becomes read-only once submitted.
- **Who sees drafts:** faculty never see drafts.
