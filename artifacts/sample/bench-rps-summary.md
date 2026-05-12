# Bench: rps-hpa @ 2026-05-12T06:15:40.898Z

Duration: 694s
Polled every: 5s

## Verdict
- ✅ p99 < 200ms target met
- ✅ Replicas scaled 2 → 9 → 3

## Key numbers
| Metric              | Value |
|---------------------|-------|
| Peak RPS (cluster)  | 956.7 |
| Baseline RPS        | 1.2 |
| Peak p99 latency    | 16ms |
| Avg p99 latency     | NaNms |
| Peak CPU %req       | - |
| Peak in-flight/pod  | 2 |
| Cache hit rate      | 89.9% |
| Peak replicas       | 9 |
| Min replicas        | 2 |
| Final replicas      | 3 |

## Scaling timeline
- Bench start:         2026-05-12T06:15:40.898Z
- Scale-up began:      2026-05-12T06:15:41.139Z
- Peak reached:        2026-05-12T06:20:51.926Z
- Scale-down began:    2026-05-12T06:24:05.374Z
- Final sample:        2026-05-12T06:27:14.133Z

## Files
- `replica-trajectory.csv` — pod count sampled every 5s
- `prometheus-snapshots.json` — captured PromQL series for the test window
- `hpa-events.txt` — kubectl describe hpa at end-of-test
- `k6-stdout.txt` — full k6 output
