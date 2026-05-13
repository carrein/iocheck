# Session: Investigate HPA scaling delays in CPU benchmark

## User

Consider:

# Bench: cpu-hpa (cold) @ 2026-05-12T09:48:56.287Z

Duration: 939s
Polled every: 5s
Workload: TARGET_RPS=5000, CACHE_BUSTER=1 (mode=cold)

## SLO check
- p99 < 200ms:        ✗ (peak 374ms)
- error rate < 1%:    ✓ (0.00% of 1,594,251 requests)
- HPA scaled:         ✓ (replicas 2 → 4 → 2)

## Key numbers
| Metric              | Value |
|---------------------|-------|
| Peak RPS (cluster)  | 4157.8 |
| Avg RPS (cluster)   | 1639.8 |
| Peak p99 latency    | 374ms |
| Avg p99 latency     | - |
| Peak CPU %req       | 48.0% |
| Avg CPU %req        | 19.6% |
| Peak in-flight/pod  | 419 |
| Cache hit rate      | - |
| Peak replicas       | 4 |
| Min replicas        | 2 |
| Final replicas      | 2 |

## Scaling timeline
- Bench start:         2026-05-12T09:48:56.287Z
- Scale-up began:      2026-05-12T09:49:57.434Z
- Peak reached:        2026-05-12T09:55:41.126Z
- Scale-down began:    2026-05-12T09:57:23.318Z
- Final sample:        2026-05-12T10:04:30.930Z


## Per-pod load distribution (last 1 min)
Evidence for Challenge #2 — kube-proxy iptables round-robins ClusterIP
connections across pods. Low cv% across pods means load is sharing evenly.

| Pod | RPS | CPU (m) |
|-----|----:|--------:|
| iocheck-74c8bccf54-hjcqr | 0.3 | 3 |
| iocheck-74c8bccf54-xcmtz | 0.3 | 2 |

Spread: RPS cv=0.0% (min 0.3, max 0.3) · CPU cv=15.2% (min 2m, max 3m)

## Files
- `replica-trajectory.csv` — pod count sampled every 5s
- `prometheus-snapshots.json` — captured PromQL series for the test window
- `hpa-events.txt` — kubectl describe hpa at end-of-test
- `k6-stdout.txt` — full k6 output


And

 There's also a fleet-average vs per-pod issue: HPA    
    averages utilization across pods. If one pod is at 80%
     and one at 16%, fleet average is 48% (right at the   
    summary number) but HPA still sees 48% and might scale
     based on its own internal recent-history. Actually no
     — at 48% fleet-avg, HPA wouldn't scale; this rules   
    out that explanation. So the dominant cause is the    
    window-length mismatch between Prom's 1m rate and     
    metrics-server's shorter window.                      
                            
    If you want to verify: query kube_horizontalpodautosca
    ler_status_current_metrics_average_utilization{horizon
    talpodautoscaler="keda-hpa-iocheck-cpu"} in Prometheus
     — that's the value the HPA actually saw, recorded by
    kube-state-metrics. It should briefly show ≥70% at the
     moments scale-up fired.

Is this a fix on our dashboard or how?

## Assistant

Short answer: yes, it's a dashboard fix — add a panel that shows what the HPA actually saw, so the artifact doesn't look self-contradictory.

It's a dashboard fix, plus one optional capture.ts tweak. Two places where the discrepancy shows up:

1. **`dashboards/iocheck.json:121` — CPU utilization panel.** It plots `rate(...container_cpu_usage_seconds_total[1m])` against the 70% target line, so when HPA fires at e.g. 75% on a 15s window, the panel still reads ~48% and looks self-contradictory. Fix: add a second series on that same panel — `kube_horizontalpodautoscaler_status_current_metrics_average_utilization{namespace="iocheck", horizontalpodautoscaler=~".*cpu.*"}` — labeled "HPA-observed". Keep the Prom rate as the smoothed/cluster view; the HPA series is the one that should cross the 70% line at scale events.

2. **`scripts/capture.ts` "Peak CPU %req" in the summary.** Same underlying query, same artifact-vs-reality gap. Either add a "Peak CPU %req (HPA-observed)" row or annotate the existing one as "Prom 1m rate" so the report doesn't read like "scaled at 48%".

Tradeoff: the HPA metric only exists while the HPA object exists, and `kube-state-metrics` exposes it with a slight lag — fine for post-hoc artifacts, not great for live debugging. That's why I'd add it alongside rather than replace.

Want me to make both changes?

## User

can u eli5 im confusef.

## Assistant

Sure.

Imagine measuring how loud a toddler screams.

- **Dashboard** averages the volume over a full minute. Toddler screams for 10 seconds, quiet for 50 — minute-average looks calm, say 48 dB.
- **HPA** averages over ~15 seconds. During that scream burst, it sees 75 dB and goes "scale up."

Both are correct. They just look at different time slices, so they disagree.

That's why your report says "peak CPU 48%" but HPA still added pods — HPA saw spikes that got smoothed away before they reached your chart.

Fix: add a second line on the CPU panel that plots *what the HPA actually saw* (`kube_horizontalpodautoscaler_status_current_metrics_average_utilization`). Then the chart will cross the 70% line right when scaling happens, instead of looking contradictory.

## User

Sounds good. Or can we change the average to match for both?

## Assistant

You can, but it makes the dashboard worse.

Two issues:

1. **You can shorten the dashboard window**, but `rate(...[15s])` with a 15-30s Prometheus scrape gives you 1-2 samples per window — very noisy, lots of gaps. That's why people default to `[1m]`.
2. **You can't really lengthen the HPA window.** The CPU HPA reads from metrics-server, whose window comes from kubelet/cAdvisor (~15-30s). It's not a knob in the HPA spec.

The windows are different *on purpose*: humans want a smoothed line they can read at a glance, HPA wants short-window so it scales before SLO breaks. Forcing them to match either gives you a jittery dashboard or a sluggish autoscaler.

So plotting both is the honest move — "fleet trend" line for humans, "HPA-observed" line to explain scale events. Want me to make the change?

## User

Ok. why is this | Avg p99 latency     | - |
not populated.

## Assistant

Bug in the query at `scripts/capture.ts:190`. The query is:

```
avg_over_time(histogram_quantile(0.99, sum by (le) (rate(...[1m])))[16m:15s])
```

`histogram_quantile` returns **NaN** when there are no samples in the inner rate window — which happens at the first eval step of the subquery, before any traffic has accumulated. Unlike `max_over_time`, **`avg_over_time` does *not* skip NaN — it propagates it**, so the whole result comes back NaN, `Number.isFinite()` rejects it, and the summary prints `-`.

That's also what the comment on line 184-186 was *trying* to fix by shrinking the window, but it doesn't fully solve it — any NaN sample in the subquery poisons the average.

Two ways to fix:

**Cheap fix** — filter NaN inside the subquery with `> 0`, which is false for NaN:
```promql
avg_over_time((histogram_quantile(0.99, ...) > 0)[${w}:15s])
```

**Better fix** — drop the "avg of p99s" idea entirely. Averaging quantiles isn't statistically meaningful (p99 of p99s ≠ p99). Compute a single p99 over the whole bench window:
```promql
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{...}[${w}])))
```
This is what most bench reports actually want when they say "p99 latency for the run."

I'd go with the second. Want me to make the change?

## User

Yeah a single p99

## Assistant

Done. `scripts/capture.ts:190` now computes a single p99 over the whole bench window via `histogram_quantile(0.99, ...[${w}])`, and the summary row is renamed `Run-window p99` so it's not mistaken for an arithmetic mean of p99s. Typecheck clean.
