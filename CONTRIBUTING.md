# Working on this repo

## First thing, on every clone

```sh
npm ci
sh tools/install-hooks.sh
```

The second line is not optional. It points git at `.githooks/`, and without it
**a push to main runs no gate at all**.

That gap is the reason this file exists. Until 2026-08-17 the gate lived only in
`.git/hooks/pre-push` — a path git never clones — and hardcoded one developer's
home directory. Five real gates ran, and none of them would have existed on a
second machine.

Verify it took:

```sh
git config core.hooksPath      # → .githooks
```

## The gate

A push to `main` is a production deploy (hospital + demo). It runs `tools/gate.sh`:

| Gate | What it protects |
|---|---|
| call-path tests | every test in `tests/`, both DB backends |
| migration safety | that `prestart` survives the deploy and the server boots |
| immune suite | frozen offline eval, from `ritu-evals` |
| boot-smoke matrix | that a bad env shape refuses rather than crash-loops |
| vendor-claim check | every third-party parameter cites `DOC:` / `MEASURED:` / `ASSUMED:` |

Run it by hand any time:

```sh
sh tools/gate.sh
```

The last three live in the sibling `ritu-evals` repo. Clone it beside this one,
or set `RITU_EVALS_DIR`. **Locally, a missing `ritu-evals` blocks the push** —
a deploy machine that cannot run the eval suite must not be quietly downgraded.

`.github/workflows/gate.yml` runs *the same script* on GitHub. Neither the hook
nor CI holds its own copy of the steps: a CI job that has drifted from the hook
reports green on checks the hook would have failed, which is worse than no CI.

### Real Postgres

`pg-mem` cannot do partial unique indexes or `uuid = ANY()`, so several booking
tests skip on it and say what they left untested. To run them:

```sh
docker run -d --name ritu-test-pg -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=ritu_test -p 55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/ritu_test npm test
```

CI does this with a service container, so nothing skips there.

### Bypassing

```sh
SUITE_BYPASS=1 git push origin main
```

For a genuine outage only. It is loud, it records who/when/which-commit to
`.gate-bypass.log`, and **CI still runs** — so a bypassed push shows up as a
failed check rather than disappearing.

## The rule that matters most

**A test must fail when the bug comes back.**

Three of four production defects in one stretch passed tests that only read
source text. Before trusting a new test, break the thing it covers and watch it
go red — then restore and watch it go green. A test that does not drive the real
code is documentation wearing a green tick.
