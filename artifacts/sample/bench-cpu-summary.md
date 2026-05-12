# Bench: cpu-hpa @ 2026-05-12T06:51:33.880Z

Duration: 609s
Polled every: 5s

## Verdict
- ✅ p99 < 200ms target met
- ❌ HPA did not scale (held at 2)

## Key numbers
| Metric              | Value |
|---------------------|-------|
| Peak RPS (cluster)  | 956.2 |
| Baseline RPS        | - |
| Peak p99 latency    | 5ms |
| Avg p99 latency     | 5ms |
| Peak CPU %req       | 20.2% |
| Avg CPU %req        | 14.2% |
| Peak in-flight/pod  | 4 |
| Cache hit rate      | 89.9% |
| Peak replicas       | 2 |
| Min replicas        | 2 |
| Final replicas      | 2 |

## Scaling timeline
- Bench start:         2026-05-12T06:51:33.880Z
- Scale-up began:      —
- Peak reached:        —
- Scale-down began:    —
- Final sample:        2026-05-12T07:01:41.061Z

## Files
- `replica-trajectory.csv` — pod count sampled every 5s
- `prometheus-snapshots.json` — captured PromQL series for the test window
- `hpa-events.txt` — kubectl describe hpa at end-of-test
- `k6-stdout.txt` — full k6 output
