# Session: Run cold RPS and CPU benchmarks with analysis

> **Archived summary.** This was a ~2,250-line bench-tuning session run
> against an earlier configuration of the harness (pgbouncer in front of
> Postgres, `COLD=1` flag, 5000 RPS, 10-min profile, `bench-rps16` and
> `bench-vertical` overlays). Many of those knobs and overlays were
> subsequently dropped during the reset-baseline pass; the calibrations
> in the live repo are different. The full transcript was archived so
> the assessor isn't misled by stale toggles. Below is what the runs
> actually demonstrated.

## What was being tested

Two back-to-back COLD benches (100% cache-miss, 5000 RPS):

1. `make bench-cpu COLD=1` — CPU-HPA scenario under DB-saturation load.
2. `make bench-rps COLD=1` — RPS-HPA scenario under the same load.

The COLD pattern was designed to expose I/O-bound failure modes that
the original hot-mix workload (~10% miss, cache-absorbed) masks.

## Headline findings

| Run | Outcome |
|---|---|
| **bench-cpu COLD** | CPU stayed at ~20–43% of request even under 5000 RPS / 100% miss; HPA stayed at 2 replicas; in-flight per pod climbed to **419**. Latency p99 blew past SLO (200ms → 433ms peak). The failure mode is exactly what the writeup describes: CPU is "doing fine" while the queue ahead of it explodes. |
| **bench-rps COLD** | RPS-HPA scaled 2→10 pods in **67 seconds**. In-flight per pod stayed ≤49 (vs 419 for CPU-HPA). p99 still elevated (~338ms over the same window) because individual pod tail latency was dominated by DB-pool wait, not CPU. RPS-HPA scale-out fixed the queue depth; tail latency would need DB-side capacity to close fully. |

These two numbers are the "punchline" the writeup expects: CPU-HPA
*can't see* this workload's saturation signal, RPS-HPA can.

## Bench-harness improvements that landed during the session

- `scripts/capture.ts` reduced to a single `p99 latency` row; SLO check
  reads from it.
- `loadtest/script.js` drain segment shortened to 1 min.
- `Makefile` gained `POST_K6_OBSERVE_S` so capture keeps polling for
  several minutes after k6 exits — scale-down lands inside the artifact.

## Why the transcript was archived

The session experimented with pgbouncer, `PG_POOL_MAX=4`,
`MISS_RATE=0.9`, `rps-hpa-16`, `bench-vertical`, and other knobs that
were later dropped. The user ultimately cancelled the run mid-way and
cleared all artifacts. The cleanups that landed in code (capture,
script, Makefile) are reflected in the current repo state and don't
need the transcript to explain themselves.

## Cluster state at end of session

`artifacts/` cleared. Cluster left running with the iocheck deployment
at whatever the in-flight overlay had patched it to. Subsequent
sessions reset the harness to the current 4-way grid
(`bench-cpu`, `bench-rps4`, `bench-rps8`, `bench-failure`).
