# Session: Compare latest CPU and RPS reports

> **Archived summary.** This was a ~1,130-line iteration session comparing
> CPU-HPA vs RPS-HPA across the hot-mix and cold (100% miss) workloads.
> Harness improvements landed locally during this session (parallelism=4,
> noConnectionReuse, expanded ephemeral port range). The cold-bench part
> hit a baseline-bias artifact and was eventually cancelled before a
> clean re-run. Curated record below.

## Hot mix (~1000 RPS, ~90% cache hit)

| Metric | CPU-HPA (15:36Z) | RPS-HPA (15:42Z) |
|---|---:|---:|
| Peak RPS | 1000.6 | 1003.0 |
| Peak p99 | 5 ms | 5 ms |
| Peak CPU %req | 19.9 % | 20.7 % |
| Peak in-flight / pod | 2 | 2 |
| **Replicas (min → peak → final)** | **2 → 2 → 2** | **2 → 10 → 7** |
| Scale-up began | — (never) | T+46s |
| Peak reached | — | T+77s |
| Scale-down began | — | T+4m15s |
| Verdict | ✅ p99, ❌ no scale | ✅ p99, ✅ scaled |

CPU-HPA never moved off the floor because CPU sat at 20 % of request, well below 70 %. RPS-HPA scaled aggressively, drained at ~1 pod per 15s. The 7-replica final state in the RPS run is bench-truncation, not steady state.

## Drain timing

From `replica-trajectory.csv`: capture only recorded **45 s of drain (10 → 7, three pods)** at steady ~1 pod / 15 s. Extrapolating at that rate, 10 → 2 would take ~2 min total. The in-flight signal was already falling before scale-down kicked in (k6 tapering), so this is the conservative estimate. This number set the `POST_K6_OBSERVE_S = 120 s` calibration that later landed in the Makefile.

## Cold mix (~5000 RPS, 100% miss) — bench breakdown

Both scenarios breach SLO under DB-saturation load. Notable result, with a caveat:

| Metric | rps-hpa-cold | cpu-hpa-cold | Δ |
|---|---:|---:|---:|
| Peak p99 | 233 ms | **247 ms** | +14 ms |
| Peak replicas | 10 | 5 | -5 |
| Final replicas | 10 | **2** (drained) | -8 |
| Peak in-flight / pod | 74 | **96** | +22 |
| Peak CPU % | 23 % | 45 % | +22 pp |

**Surprise finding:** CPU-HPA *did* scale under cold load — it triggered at 45 % CPU and pushed to 5 pods, then drained back to 2 mid-bench while load was still active.

**Caveat:** the cpu-cold run started from 3 pods (rps-cold leftover; HPA had not finished draining when the next bench fired), so cpu-cold's "scaled to 5" is really "scaled by 2." A clean 2-pod baseline would widen the gap. User cancelled the proposed re-run before a clean comparison; the directional finding (RPS-HPA scales more aggressively → lower p99 + in-flight) held.

## Harness fixes that landed during the session

- **k6 `parallelism: 4` + `completions: 4`.** A single k6 pod with `noConnectionReuse` hit `ETIMEDOUT` past ~500 RPS — macOS-loopback ephemeral port exhaustion. Four pods × ~250 RPS = clean 1000 RPS sustained without generator stalls.
- **`noConnectionReuse: true` in k6 script.** Required to bust HTTP/1.1 keep-alive's per-connection pod stickiness so newly-scaled replicas actually see traffic.
- **`net.ipv4.ip_local_port_range = 1024 65535` securityContext sysctl.** Expanded ephemeral port range from default 32768–60999 to absorb fresh-connect bursts. Set in `loadtest/job.yaml`.

These are all live in the current loadtest/.

## Lessons that fed forward

1. **Always reset to `minReplicaCount` between benches.** The cpu-cold baseline-bias was a foundational lesson — every bench from this point on calls `kubectl apply -k manifests/iocheck` to reset the deployment before applying the scenario overlay (now `_bench` step [1/7] in the Makefile).
2. **`POST_K6_OBSERVE_S` is non-negotiable.** Without ~2 min of post-k6 observation, scale-down never lands in the artifact and the run looks like it pegged at the ceiling.
3. **CPU-HPA *can* fire under genuinely bursty I/O loads** (cold = 100 % cache miss → PG round-trip dominates → CPU climbs into the trigger band). The "CPU is the wrong signal" claim is calibration-dependent, not absolute — the writeup frames it around the realistic cache-fronted shape.

## Cluster state at cancellation

Harness fixes landed locally and ready to commit. Two bench artifacts in `artifacts/` (rps-hpa-cold and cpu-hpa-cold with the 3-pod head start). User said "cancel" rather than re-run cpu-cold from a clean baseline.
