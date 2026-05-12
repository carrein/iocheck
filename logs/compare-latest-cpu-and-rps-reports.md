# Session: Compare latest CPU and RPS reports

## User

Compare the latest two reports for cpu and rps

## Assistant

> Bash: ls -la /Users/carrein/Desktop/iocheck2/artifacts/

## Assistant

> Bash: ls /Users/carrein/Desktop/iocheck2/artifacts/cpu-hpa-20260512T153645Z/ /Users/carrein/Desktop/iochec...

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/artifacts/cpu-hpa-20260512T153645Z/summary.md

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/artifacts/rps-hpa-20260512T154221Z/summary.md

## Assistant

Side-by-side comparison of the latest CPU-HPA vs RPS-HPA runs (both ~5 min, ~1000 peak RPS, 90% cache hit, p99 = 5ms):

| Metric | CPU-HPA (15:36Z) | RPS-HPA (15:42Z) |
|---|---|---|
| Peak RPS | 1000.6 | 1003.0 |
| Avg RPS | 527.1 | 578.4 |
| Peak p99 | 5 ms | 5 ms |
| Peak CPU %req | 19.9% | 20.7% |
| Peak in-flight/pod | 2 | 2 |
| **Replicas (min → peak → final)** | **2 → 2 → 2** | **2 → 10 → 7** |
| Scale-up began | — (never) | T+46s |
| Peak reached | — | T+77s |
| Scale-down began | — | T+4m15s |
| Verdict | ✅ p99, ❌ no scale | ✅ p99, ✅ scaled |

**The headline finding stands:** at this workload (cache-hot, ~1k RPS, p99 = 5ms), CPU utilization peaks at ~20% of request — well under any sane CPU HPA threshold — so CPU-HPA never triggers. RPS-HPA, scaling on in-flight requests per pod, scales 2→10 in ~30s and gracefully drains back to 7. Same SLO, same load, only the RPS scenario actually autoscales.

The 7-replica steady state at the end of the RPS run looks like the cooldown window not having fully expired by T+5min — worth confirming in `replica-trajectory.csv` if you want a tighter end-state number.

## User

How long does it take to drain?

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/artifacts/rps-hpa-20260512T154221Z/replica-trajectory.csv

## Assistant

Drain started at 07:46:36 (10 → 9) and capture ended at 07:47:21 at 7 replicas — so the bench only captured **45 seconds of drain (10 → 7, three pods)**, a steady **~1 pod per 15s**.

```
07:46:36  10 → 9
07:46:51   9 → 8   (+15s)
07:47:06   8 → 7   (+15s)
07:47:21   still 7  (end of capture)
```

The trajectory tells you why: the in-flight metric was already falling before scale-down kicked in (100297m → 73232m → 63336m → 53257m), so k6 is tapering off in the final segment, not holding steady. Capture stops ~5s after k6 wraps up, which is why we don't see it land back at 2.

**Extrapolating at 1 pod / 15s:** 7 → 2 would take another ~75s, so total drain ≈ **2 minutes from peak to floor**. That matches the `scaleDown` behavior typical of KEDA defaults (300s stabilization + `periodSeconds: 15`, `policies: 1 pod`).

If you want the actual full-drain number, bump `capture.ts`'s tail window past the k6 end-time, or check `manifests/overlays/rps-hpa/scaledobject.yaml` to confirm the configured `cooldownPeriod` / `behavior.scaleDown`.

## User

I see. What's our current setup?

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/manifests/overlays/rps-hpa/scaledobject.yaml

## Assistant

`manifests/overlays/rps-hpa/scaledobject.yaml`:

| Knob | Value | What it does |
|---|---|---|
| `pollingInterval` | 15s | KEDA queries Prometheus |
| `cooldownPeriod` | 60s | KEDA-level cooldown before scale-to-zero (n/a here, min=2) |
| `minReplicaCount` / `maxReplicaCount` | 2 / 10 | |
| `fallback.replicas` | 4 (after 3 missed polls) | Prometheus-down safety net |
| `scaleUp.stabilizationWindowSeconds` | 0 | React immediately on spike |
| `scaleUp.policies` | +100% **or** +4 pods / 15s | Whichever is larger |
| `scaleDown.stabilizationWindowSeconds` | 60s | Wait 60s of "want to shrink" before acting |
| `scaleDown.policies` | −25% / 60s | Cap drain rate |
| **Trigger** | `sum(rate(http_requests_total{service="iocheck"}[1m]))` | Cluster-total RPS |
| **Threshold** | 100 RPS/pod (`metricType: AverageValue` → HPA divides by replica count) | |
| **Activation** | 5 RPS | Below this, no scaling |

**Drain math from this config:** 25%/60s means 10 → 8 → 6 → 5 → 4 → 3 → 2 in ~6 windows = **~6 min worst-case from peak**.

**But the bench observed ~1 pod / 15s**, faster than the 25%/60s ceiling would allow. Two likely explanations:
1. The 25% policy is a *ceiling*, but HPA can also drop by smaller increments per 15s reconcile — and with the metric already collapsing fast (k6 ramp-down), each tick decides to shrink by 1.
2. The 60s stabilization may have already elapsed before our first observed drop, so we caught it mid-stream.

If you want predictable drain timing for the demo, the levers are `scaleDown.stabilizationWindowSeconds` (currently 60s) and the `policies` array. The CPU overlay (`manifests/overlays/cpu-hpa/scaledobject.yaml`) is worth a side-by-side glance if you want to confirm parity of the non-trigger fields.

## User

Consider the data. Do we need to grok anything?

## Assistant

A few things in the data are doing more work than the headline suggests:

**1. CPU peaked at 20%. The "CPU-HPA failed" framing is generous.**
With 2 pods serving 1000 RPS at 20% CPU, CPU-HPA didn't fail — there was no CPU pressure to react to. A skeptical reviewer will say "why scale at all?" The answer has to be either (a) headroom for cache-miss spikes or (b) latency at saturation — neither of which this bench actually demonstrates. p99 = 5ms in both runs means **we never went near the knee**. The RPS-HPA "wins" only if you accept that RPS is the right signal; from CPU's perspective the system is over-provisioned at 10 pods.

**2. The 200 RPS/pod saturation claim looks stale.**
`scaledobject.yaml:8-10` says "~200 RPS sustainable per pod, threshold 100 = 2x headroom." But the data shows 2 pods at 500 RPS each hitting only 20% CPU. That's not 2x headroom — that's ~5–10x. Either the calibration was done under different cache conditions, or the threshold should be higher. Worth re-deriving against current numbers before defending it in a walkthrough.

**3. 90% cache hit rate is silently dominating everything.**
Both runs are in the cache-hot regime. p99 = 5ms, in-flight = 2, CPU = 20% — these are all symptoms of "cache absorbs the work." A cache-cold (or cache-degraded) run would likely change which autoscaler wins, *and by how much*. The current benches don't prove the autoscaler choice is robust — only that it's correct in the easy regime.

**4. The bench window is too short to capture full drain.**
Capture ended at 7 replicas while still draining. We're extrapolating the last 60% of the scale-down curve. Either extend `capture.ts` past k6 end, or shorten `scaleDown.stabilizationWindowSeconds` for the demo so the full 10→2 lands inside the window.

**5. In-flight = 2/pod is a hint about metric choice.**
Requests are so fast (~5ms) that in-flight concurrency never builds up. RPS works as a proxy *here*. If requests got slower (cache miss, DB stall), in-flight would explode before RPS did — so `in-flight` is arguably a more direct saturation signal than RPS. Mentioning this in the writeup pre-empts the obvious "why not concurrency?" question.

The first two are the ones I'd act on before the demo. Want me to re-derive the saturation point from the current Prometheus data?

## User

Can you make suggestions for all 5 and i will approve.

## Assistant

Here's what I'd propose for each — pick which to act on:

**1. Reframe CPU-HPA narrative in `WRITEUP.md`**
Replace "CPU-HPA failed" with the honest version: *"At 90% cache hit, the workload never generates CPU pressure, so CPU-HPA correctly does nothing. The lesson isn't 'CPU-HPA is broken' — it's 'CPU is the wrong signal for an I/O-bound, cache-fronted service.'"* Then point at #3 below as the regime where CPU-HPA actually fails for the *right* reasons.
**Touches:** `WRITEUP.md` (Challenge 2 / autoscaler comparison section).

**2. Re-derive the single-pod saturation point**
Add a `make .calibrate` private phase that: scales iocheck to 1 replica, runs k6 with an open-loop ramp (50 → 500 RPS over 5 min), captures CPU%, in-flight, p99. The knee (p99 > 50ms or CPU > 70%) is the new saturation number. Update the YAML comment at `manifests/overlays/rps-hpa/scaledobject.yaml:8-10` and the threshold if the math changes (target = saturation / 2).
**Touches:** new `scripts/calibrate.ts` or k6 stage, Makefile phase, scaledobject YAML, `.claude/plans/iocheck-plan.md` rationale block.

**3. Add a cache-cold variant to expose CPU-HPA failure mode**
Modify `loadtest/script.js` to support a `CACHE_BUSTER=1` mode that generates high-cardinality lookups (random IOC strings) so cache hit drops to ~10%. Add `make bench-rps-cold` / `make bench-cpu-cold` — *or* keep the 4-target surface and make it a flag (`make bench-rps COLD=1`). This is where CPU-HPA should actually break and RPS-HPA earns its keep.
**Touches:** `loadtest/script.js`, `loadtest/configmap.yaml`, Makefile, `WRITEUP.md`. ⚠️ This contradicts your "tiny CLI surface" rule — flag is probably better than new targets.

**4. Fix bench-window truncation in `scripts/capture.ts`**
Extend the post-k6 tail from ~5s to 180s so we capture the full 10→2 drain. Cleaner than shortening `scaleDown.stabilizationWindowSeconds`, which would degrade real-world behavior to fit the bench. Bench total goes from 5min → ~8min, still well inside "30-min walkthrough" budget.
**Touches:** `scripts/capture.ts` only.

**5. Justify RPS-over-in-flight in writeup, don't change the metric**
Add 2–3 sentences to `WRITEUP.md` explaining: *"RPS is a leading indicator (rises before latency); in-flight is a lagging one (rises only after queue builds). At 5ms requests, in-flight stays at 2 until something is already wrong. RPS lets us scale before degradation."* Optionally note in-flight as a candidate secondary trigger for future work. **Don't** swap the metric — would invalidate the existing benches.
**Touches:** `WRITEUP.md` only.

**My recommendation if you're triaging:** do **4** first (cheap, unblocks honest data for everything else), then **2** (the calibration is the foundation everything else stands on), then **3** (the strongest demo moment), then **1** and **5** (writeup polish).

Which subset do you want me to implement?

## User

How will you modify the test such that we can achieve CPU-HPA failed condition? I would like our narrative - at the end of the day to be that RPS is better because it performs better + scales.

## Assistant

To produce the "RPS-HPA wins on both axes" narrative honestly, we need a workload where (a) CPU stays under threshold even when pods are saturated, and (b) latency degrades enough that CPU-HPA visibly costs SLO. Cache-bust + higher load does both, because Bun is async — pods get I/O-saturated long before CPU notices.

**Mechanism (why this works)**
A random IOC misses Redis → forces a Postgres roundtrip. Each request goes from ~5ms (mostly cache CPU) to ~15–25ms (mostly DB wait). On Bun's event loop, that wait is non-blocking — CPU stays ~30–40%, well under any sane CPU-HPA threshold. But in-flight per pod climbs, the DB pool (10 conns/pod) starts queueing, and p99 blows past the 200ms SLO. RPS, meanwhile, climbs immediately and trips the RPS-HPA in <30s.

**Concrete changes**

**1. `loadtest/script.js`** — add cache-bust mode
```js
const CACHE_BUSTER = __ENV.CACHE_BUSTER === '1';
function pickIoc() {
  return CACHE_BUSTER
    ? crypto.randomBytes(16).toString('hex')  // 100% cache miss, 100% DB miss
    : SEEDED_IOCS[Math.floor(Math.random() * SEEDED_IOCS.length)];
}
```
Random hex always misses cache *and* DB — the DB still does the indexed lookup (cost we want), just returns empty. No server-side change needed.

**2. Bump target RPS to ~2000 in cold mode**
At 1000 RPS over 2 pods, cache-cold gives each pod 500 RPS × 20ms = 10 in-flight, which queues but might not breach SLO definitively. At 2000 RPS, each pod sees ~1000 RPS × 20ms = 20 in-flight against a pool of 10 — that's *clear* saturation. CPU-HPA stays asleep, p99 breaches, RPS-HPA scales to 10 and recovers.

**3. `loadtest/configmap.yaml` + Job** — plumb `CACHE_BUSTER` and `TARGET_RPS` envs through to k6.

**4. Makefile** — add `COLD=1` flag, no new top-level targets:
```make
bench-cpu:
	@CACHE_BUSTER=$(if $(COLD),1,0) TARGET_RPS=$(if $(COLD),2000,1000) ./scripts/run-bench.sh cpu-hpa
```
Preserves the 4-target surface. `make bench-cpu COLD=1` is the cache-cold variant.

**5. `scripts/capture.ts`** — record `CACHE_BUSTER` and `TARGET_RPS` in `summary.md` so artifacts are self-describing.

**6. `WRITEUP.md`** — restructure Challenge 2 as a two-regime story:
- **Cache-hot (default bench):** Both autoscalers hold SLO. RPS-HPA scales preemptively (2→10), CPU-HPA stays at 2 because there's nothing to scale on. *Lesson: even in the easy regime, RPS-HPA tracks demand; CPU-HPA is blind to it.*
- **Cache-cold (`COLD=1`):** RPS-HPA holds p99 < 50ms by scaling to 10 in ~30s. CPU-HPA breaches SLO (p99 > 200ms) because CPU stays at ~35% — never crosses any reasonable threshold. *Lesson: for I/O-bound async services, CPU is structurally the wrong signal.*

Both regimes point the same direction → narrative is coherent.

**Expected results (the bet I'm making)**

| | bench-cpu (hot) | bench-cpu **COLD** | bench-rps (hot) | bench-rps **COLD** |
|---|---|---|---|---|
| Peak CPU | 20% | ~35% | 20% | ~35% |
| Peak p99 | 5ms | **>200ms ❌** | 5ms | <50ms ✅ |
| Replicas | 2 (no scale) | 2 (no scale ❌) | 2→10 | 2→10 ✅ |

If COLD doesn't actually breach p99 on CPU-HPA at 2000 RPS, the next dial is target RPS — push to 3000. If it breaches *too* hard (pods crash), we lower it. Either way, calibration happens before we commit the writeup numbers.

**Risk / honesty check**
The one trap: if `bench-rps COLD` *also* breaches SLO during the scale-up window (the 30s before pods are ready), the story weakens. Mitigation: the existing `scaleUp.stabilizationWindowSeconds: 0` + `+100% or +4 pods / 15s` policy is already aggressive. If it still breaches, we honestly note "RPS-HPA reduces breach duration from 5 minutes to 30 seconds" — still a clear win, just less absolute.

Want me to start implementing? If yes, I'd do it in this order:
1. k6 script + configmap + makefile flag (cheap, ~15 min)
2. Run `make bench-cpu COLD=1` once to confirm the failure mode lands
3. Run `make bench-rps COLD=1` to confirm the win lands
4. *Then* update capture.ts annotations and WRITEUP.md based on actual numbers, not my predicted ones

Approve?
