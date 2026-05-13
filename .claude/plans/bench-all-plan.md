# bench-all — Implementation Plan
Created: 2026-05-13
Status: COMPLETE

## Context

Add a `make bench-all` target that runs the three comparable autoscaler
scenarios (cpu-hpa, rps-hpa-4, rps-hpa-8) under the same workload and emits a
single markdown comparison table to `artifacts/`. Each individual `bench-*`
target already writes a per-bench `summary.md` with a key-numbers table;
`bench-all` aggregates these into a side-by-side view so the assessor can
scan one file to see which autoscaler shape wins on this workload.

Design decisions settled in Phase 1:

- **Scope**: cpu-hpa, rps-hpa-4, rps-hpa-8. Exclude `bench-failure`
  (different question — resilience under metric outage, not throughput).
- **Layout**: single nested run dir `artifacts/bench-all-<ts>/` containing the
  three per-bench subdirs plus `comparison.md`. A standalone sibling
  `comparison-<ts>/` dir cannot reliably reference its source bench dirs
  without parsing stdout or scanning by timestamp; nesting eliminates the
  coupling.
- **Columns**: scenario · p99 · error rate · peak replicas · 3 SLO ✓/✗
  marks · link to per-bench `summary.md`.
- **Naming**: `bench-all`, additive. Surface grows from 6 → 7 public targets.
- **Overrides**: `MISS_RATE` and `TARGET_RPS` honored, same as today.
- **Failure handling**: continue on individual sub-bench failure, mark the
  row, exit non-zero overall.

## Research Summary

No external research needed — pure orchestration of in-repo tooling:

- `scripts/capture.ts` already computes every number needed for the
  comparison table; it just doesn't emit them in machine-readable form.
  Adding a sibling `summary.json` write is a few lines.
- Make recursive invocation (`$(MAKE) bench-cpu` etc.) was already in use
  elsewhere in the Makefile, so no new patterns.
- The artifact-dir naming is a coupling point: `_bench` generates
  `artifacts/<scenario>-<mode>-<ts>/` internally. Making this externally
  controllable for `bench-all` required one env override (`ARTIFACT_DIR`).

## Approach

### Design priorities

1. **Simplicity** — reuse the existing `bench-*` targets via recursive make
   rather than re-implementing the bench loop.
2. **Explicit and traceable** — pass artifact paths via env, not by scanning
   the filesystem after-the-fact.
3. **Reusability** — emit machine-readable `summary.json` from capture.ts
   so any future aggregator (e.g. comparing across MISS_RATE sweeps) can
   reuse the same shape.

### Data flow

```
make bench-all MISS_RATE=0.8
  ├─ ts := $(date)
  ├─ run_root := artifacts/bench-all-<ts>
  ├─ for scenario in cpu-hpa rps-hpa-4 rps-hpa-8:
  │    ARTIFACT_DIR=<run_root>/<scenario> $(MAKE) bench-<scenario>
  │      └─ _bench honors $ARTIFACT_DIR; capture.ts writes
  │         summary.md + summary.json + raw artifacts there
  ├─ bun run scripts/compare.ts <run_root>
  │    └─ reads <run_root>/*/summary.json, writes
  │       <run_root>/comparison.md
  └─ exit non-zero iff any bench failed
```

## Implementation phases

### Phase A — structured summary in capture.ts

Refactored the summary computation in `scripts/capture.ts` to populate a
single `summary` object with all key numbers and SLO booleans. After
writing `summary.md`, the same object is written to `summary.json`
(pretty-printed for git-diffability). Null is used for unavailable
Prometheus reads so a consumer can distinguish "0" from "missing".

### Phase B — comparison aggregator

`scripts/compare.ts` (~130 lines, Bun, no external deps) takes one argv
path (the bench-all run root), reads `<root>/cpu-hpa/summary.json`,
`<root>/rps-hpa-4/summary.json`, `<root>/rps-hpa-8/summary.json`,
skipping any missing (failed) ones with a row marked `failed ✗`, and
writes `<root>/comparison.md` with the headline table. Each row's
"scenario" cell links to the per-bench `summary.md` via relative path.

### Phase C — Makefile target

`_bench` now expands `artdir` as
`$${ARTIFACT_DIR:-artifacts/<scenario>-<mode>-<ts>}` so it honors the
env override that `bench-all` sets per sub-bench. The standalone
`bench-*` paths are unchanged in behavior because no caller exports
`ARTIFACT_DIR` for them. New `bench-all` target picks a single
timestamp, creates `artifacts/bench-all-<ts>/`, calls each `bench-*`
with `ARTIFACT_DIR` pointing at a subdir, tracks per-scenario exit
code without aborting the run, invokes `bun run scripts/compare.ts`,
and exits non-zero iff any sub-bench failed.

### Phase D — docs

`README.md` quickstart + demo section + repo-layout footer updated.
`CLAUDE.md` "assessor surface" bumped 6 → 7 targets with a new paragraph
describing the bench-all data flow and the `ARTIFACT_DIR` override.
Makefile header comment + help text + post-up "Next steps" block all
mention bench-all. WRITEUP.md was intentionally skipped — it's the
architecture doc, not the CLI reference.

## Edge cases & error handling

- **A bench fails before producing summary.json**: compare.ts emits a row
  with `failed ✗` and the explanation "no summary.json found".
- **`make bench-all` invoked without cluster up**: the first `_bench` fails
  fast on the existing "cluster not running. Run 'make up' first." guard;
  the error propagates and the rest of the runs are skipped.
- **`ARTIFACT_DIR` env passed by user manually**: honored, same as
  bench-all does internally. Not documented in user-facing help — it's a
  private knob.
- **MODE derivation**: `_bench` still derives MODE for echo output even
  when ARTIFACT_DIR is externally controlled; the MODE-suffixed dir name
  is no longer used (overridden by ARTIFACT_DIR) but MODE still appears
  in summary headers for human readability.
- **comparison.md if zero benches succeeded**: written anyway with an
  "all 3 benches failed" header and per-row failure notes.

## Risks & open questions

- **Wall clock**: ~5 min × 3 = ~15 min for `make bench-all`. Acceptable
  for an unattended assessor run; flagged in README.
- **No live smoke**: end-to-end `make bench-all` was not run against a
  live cluster at delivery time (reviving the cluster for a 15-minute
  test was out of scope for this build). Phase A and B were verified by
  typecheck + synthetic-data dry-run of compare.ts against both happy
  and failure paths. Phase C was verified by `make help` rendering
  correctly and the bench-all target reaching the cluster guard with
  the correct exit code.

## Build Log

- **Phase A** — `summary.json` write added right after the existing
  `summary.md` write. Typecheck clean.
- **Phase B** — `scripts/compare.ts` smoke tested against synthetic
  summary.json files for both the happy path (3 rows, exit 0) and the
  failure path (1 missing summary, exit 1, row marked
  `failed — no summary.json`). Required an `export {}` at the bottom
  since the script has no imports/exports otherwise and TS wouldn't
  treat it as a module without one.
- **Phase C** — `_bench` honors external `ARTIFACT_DIR`; standalone
  `bench-*` paths unchanged. `bench-all` nests cpu/rps4/rps8 under
  `artifacts/bench-all-<ts>/`, collects per-sub-bench exit codes,
  continues on failure, invokes compare.ts. `make help` renders;
  cluster guard fires correctly when down.
- **Phase D** — README quickstart + demo section + repo-layout footer
  updated; CLAUDE.md surface bumped 6 → 7; Makefile header comment +
  help text + post-up "Next steps" block all mention bench-all.

## Summary

Completed: 2026-05-13

Files created:
- `scripts/compare.ts` — Bun aggregator: reads N summary.json → writes comparison.md
- `.claude/plans/bench-all-plan.md` — this file

Files modified:
- `scripts/capture.ts` — emits `summary.json` alongside `summary.md`
- `Makefile` — `bench-all` target + `_bench` honors external `ARTIFACT_DIR`
- `README.md` — quickstart + demo section + scripts/ list
- `CLAUDE.md` — surface description bumped 6 → 7 targets, new data-flow paragraph

Key decisions:
- **Nested run dir** (`artifacts/bench-all-<ts>/{scenario}/…`) instead of
  the originally proposed sibling `comparison-<ts>/`. A freestanding
  comparison dir couldn't reliably reference its source bench dirs
  without parsing stdout or matching by timestamp; nesting eliminates
  that coupling.
- **JSON sibling** (`summary.json`) over markdown parsing. Adding ~30
  lines to capture.ts is cheaper and far more robust than a markdown
  text parser in the aggregator.
- **Continue on individual failure**: bench-all collects per-sub-bench
  rc into a shared variable and only exits non-zero at the end. The
  comparison.md still renders, with failed rows flagged.
- **Excluded bench-failure from the comparison set**: it tests
  resilience under metric outage (writeup §4), not steady-state
  throughput. Folding it into a throughput table would dilute both.
