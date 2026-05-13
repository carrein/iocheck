# Session: Reset bench harness to v1 baseline

> **Archived summary.** This was a ~1,160-line two-part session that reset
> the bench harness back to a low-variance 4-bench grid and stripped a
> pgbouncer experiment that had been added during an earlier saturation
> probe. Some of the post-reset state described in this session was
> further evolved later (bench-all aggregator added, inflight-hpa
> overlay later dropped entirely). Below is the curated record.

## Part 1 — Reset to baseline

**Goal:** restore a repeatable 4-bench baseline. Each `make bench-*`
should produce consistent numbers across runs. Drop the saturation
tuning + extra cleanup machinery that had accreted during the v2-v6
iteration cycle.

**Calibrations locked in:**
- `TARGET_RPS` default: 1000 (was 8000)
- `MISS_RATE` default: 0.8 (unchanged)
- k6 profile: 30s ramp + 90s sustain + 30s drain
- `POST_K6_OBSERVE_S`: 120s
- k6 parallelism + completions: 4 (was 12)
- k6 pod CPU request: 500m (was 250m)
- Per-bench wall clock: ~5 min total

**Surface trimmed:** dropped `bench-vertical` and `bench-inflight`
targets. Settled on `make up`, `make bench-cpu`, `make bench-rps4`,
`make bench-rps8`, `make bench-failure`, `make down` (later extended
with `bench-all`). The `manifests/overlays/vertical/` directory was
deleted; the `inflight-hpa` overlay was initially kept as a
future-work reference, then dropped entirely in a later pass.

**Bench step [1/7] simplified.** Reverted to `kubectl apply -k
manifests/iocheck → kubectl delete scaledobject --all → kubectl
apply -k $OVERLAY → kubectl wait for scaledobject Ready or
deployment rollout → sleep 3`. Removed the
force-delete-k6-pods / wait-for-iocheck@2 /
wait-for-worker-CPU<25% hardening that had been added during the
saturation experiments — none of it is needed when the workload
holds steady at 1000 RPS.

**Files touched:**
- `Makefile` — assessor surface trimmed, defaults reset, step [1/7]
  simplified.
- `loadtest/script.js` — default 1000 RPS, stages 30s/90s/30s,
  docstring rewritten.
- `loadtest/job.yaml` — `parallelism: 4`, `completions: 4`,
  `TARGET_RPS="1000"`, k6 CPU request 500m.
- `manifests/overlays/rps-hpa-{4,8}/scaledobject.yaml` — uniform
  `pollingInterval: 15`, `scaleUp.periodSeconds: 15`, tuning-rationale
  comments stripped.
- `scripts/capture.ts` — `TARGET_RPS` default `"1000"`.
- WRITEUP §3 acknowledges max=4 + max=8 ceilings + new timing;
  Challenge 4 table placeholder marked `_tbd_` until benches re-run.
- README + CLAUDE.md — assessor surface reset.

## Part 2 — pgbouncer strip + docs sync

The earlier saturation experiments had added a pgbouncer deployment
(transaction-pool mode, `default_pool_size=25`) between iocheck and
Postgres. Validation showed that the live service was bypassing it:
`src/db.ts` connects to `DATABASE_URL` from env, which
`manifests/iocheck/configmap.yaml` had set to
`postgres.iocheck.svc.cluster.local:5432` direct — so the pgbouncer
service was deployed but never on the request path. Removed cleanly:

- Deleted `manifests/pgbouncer/` (4 files: deployment, configmap,
  service, kustomization).
- Removed `- pgbouncer` from `manifests/kustomization.yaml`.
- Dropped pgbouncer archaeology comment from
  `manifests/iocheck/configmap.yaml`.
- Scrubbed pgbouncer mentions from `iocheck-plan.md` (future-work
  section) and `iocheck-research.md`.
- Deleted two untracked scratch plans
  (`bun-pgbouncer-research.md`,
  `find-replica-latency-bottleneck-plan.md`).
- Base manifest kustomize output dropped 528 → 399 lines with no
  broken references.

## Loose ends at end of session

- 4-bench grid hadn't been re-run against the new harness; WRITEUP §3
  Challenge 4 table carried `_tbd_` placeholders.
- Working tree was full of staged-but-uncommitted changes (Makefile,
  README, WRITEUP, CLAUDE.md, configmap.yaml, kustomization.yaml,
  src/lookup.ts, src/metrics.ts, plus new untracked overlay
  directories and session logs). No commit made.
