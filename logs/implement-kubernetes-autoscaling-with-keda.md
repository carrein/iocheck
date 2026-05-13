# Session: Implement Kubernetes autoscaling with KEDA

> **Archived summary.** This was a ~615-line "correctness check" session
> framed as no-implementation research (compare local repo against a
> reference implementation, look up canon and prior precedence, walk
> EXERCISE.md line by line). It ended up making four small but durable
> code changes anyway. The transcript was archived because much of the
> scaffolding (Task tool ceremony, lookup spam) doesn't aid an assessor.
> Below is the contribution that stuck.

## Framing

> This exercise was completed with the assistance of Claude (Opus 4.7).
> Claude's role: parse the problem statement, teach concepts (KEDA,
> Prometheus, Little's Law), research prior art (Knative concurrency,
> Zalando's autoscaler), and scaffold the implementation via Claude
> Code. Every design decision is mine.

## What the session landed

1. **KEDA fallback behavior switched from `static` to
   `currentReplicasIfHigher`** in the rps-hpa overlay (later inherited
   by `rps-hpa-4` and `rps-hpa-8`). Rationale: plain `static` would
   *shrink* the deployment to the fallback count if Prometheus dies
   during a burst, which is the opposite of what's wanted. With
   `currentReplicasIfHigher`, the fallback only kicks in if current
   replicas are below the fallback number — burst capacity is preserved
   through the metric outage. This is the writeup §4 deliverable.
2. **`scripts/capture.ts` SLO check restructured** — added `promBy` /
   `stats` helpers, queries for error rate / total requests / per-pod
   RPS / per-pod CPU, and an explicit SLO check section with
   `p99 < 200ms`, `error rate < 1%`, `HPA scaled` lines. Also added a
   "Per-pod load distribution" section.
3. **WRITEUP §4 mitigation bullet updated** to describe the new
   fallback behavior.
4. **A `bench-rps-miss` Makefile target was added** at the time. This
   target was later removed during the reset-to-baseline pass — the
   `MISS_RATE` override on the standard bench-* targets covers the same
   workload (`make bench-rps8 MISS_RATE=1.0`).

## What was NOT verified at session time

The Prometheus queries assume specific label names (`pod` on
`http_requests_total` and `container_cpu_usage_seconds_total`). The
shape follows existing capture.ts conventions, but only `make
bench-rps` against a live cluster would confirm the panels populate.
Subsequent bench runs confirmed they do.
