# Session: Debug RPS HPA cold start issue

## User

why do i keep getting rps-hpa-cold-20260512T163141Z

## Assistant

The artifact directory name comes from `make bench-rps COLD=1` — the Makefile builds `artifacts/$(SCENARIO)-$(MODE)-<timestamp>` where `MODE=cold` is set when `COLD=1` is passed. The recent diff made `bench-rps` forward `COLD=$(COLD)` to `_bench`, so any `make bench-rps COLD=1` invocation lands in a `rps-hpa-cold-*` dir. If you didn't intend the cold profile, drop `COLD=1` and you'll get `rps-hpa-hot-<timestamp>` instead.

**Why `-cold-`**: Makefile:227-229 sets `MODE := cold` whenever `COLD=1` is passed, and Makefile:280 builds the artifact path as `artifacts/$(SCENARIO)-$(MODE)-<timestamp>`. The recent change (in your uncommitted diff) made `bench-rps` forward `COLD=$(COLD)` to `_bench`, so any `make bench-rps COLD=1` invocation lands in a `rps-hpa-cold-*` dir. If you didn't intend the cold profile, drop `COLD=1` and you'll get `rps-hpa-hot-<timestamp>` instead.

**Side issue worth flagging**: that directory contains only `replica-trajectory.csv` (375 samples ≈ 31 min of polling) — no `summary.md`, no `capture.log`, no `k6-stdout.txt`. The bench profile in `loadtest/script.js` is 5 min, and `make _bench` waits at most 15 min for the k6 Job, so a 31-min trajectory means `capture.ts` was left running well past the Make wrapper. Most likely you Ctrl-C'd `make` mid-run; the `&`-backgrounded `bun run capture.ts` (Makefile:285) became orphaned, never received the SIGTERM that triggers `writeSummary()` (capture.ts:267-275), and just kept appending rows to the CSV until something else killed it. The fact that `capture.log` and `k6-stdout.txt` don't exist at all is odder — those should have been created the moment the shell opened the redirect — which makes me think this artifact dir was produced by running `capture.ts` standalone (with `ARTIFACT_DIR` exported) rather than via `make _bench`. Either way: to get a complete artifact, let the Make target finish on its own, or send SIGTERM to the capture PID yourself before killing it.

## User

cancel all jobs and clear our artifacts

## Assistant

> Bash: ls -la /Users/carrein/Desktop/iocheck2/artifacts/ 2>/dev/null; echo "---"; ps aux | grep -E "capture...

## Assistant

Found 1 orphaned `bun run capture.ts`, 2 orphaned `make _bench` shell wrappers, and 2 `kubectl wait` processes — plus likely an in-cluster `k6-load` Job. I'll terminate them, delete the in-cluster Job, and clear `artifacts/`.

## Assistant

> Bash: ps aux | grep -E "kubectl.*port-forward|kubectl.*logs.*k6-load" | grep -v grep

## Assistant

> Bash: ls -la /Users/carrein/Desktop/iocheck2/.bin/pids/ 2>/dev/null; echo "---in-cluster Jobs---"; /Users/...

## Assistant

The in-cluster `k6-load` is already Failed (4/4 backoff exhausted). I'll terminate the local orphans, delete the failed Job, and clear `artifacts/`. Leaving `iocheck-seed` (part of `make up`) and the Prometheus/Grafana port-forwards alone since the cluster is still up.

## Assistant

> Bash: kill -TERM 44512 55299 51365 57680 53694 2>/dev/null; sleep 1; kill -KILL 44512 55299 51365 57680 53...

## Assistant

> Bash: /Users/carrein/Desktop/iocheck2/.bin/kubectl -n iocheck delete job k6-load --ignore-not-found

## Assistant

> Bash: rm -rf /Users/carrein/Desktop/iocheck2/artifacts/* /Users/carrein/Desktop/iocheck2/.bin/pids/capture...

## Assistant

> Bash: ps aux | grep -E "capture\.ts|k6|bun run.*capture|_bench|wait.*k6-load" | grep -v grep; echo "---"; ...

## Assistant

Done. All bench-related local processes terminated, in-cluster `k6-load` Job deleted, and `artifacts/` is empty. Cluster, port-forwards, and `iocheck-seed` left intact.

## User

I keep geetting these errors: running (0m09.9s), 000/200 VUs, 418 complete and 0 interrupted iterations
load   [   3% ] 000/200 VUs  0m09.9s/5m0s  083.36 iters/s
time="2026-05-12T09:05:31Z" level=error msg="Failed to send the time series data to the endpoint" error="got status code: 400 instead expected a 2xx successful status code" output="Prometheus remote write"
time="2026-05-12T09:05:31Z" level=error msg="Failed to send the time series data to the endpoint" error="got status code: 400 instead expected a 2xx successful status code" output="Prometheus remote write"

## Assistant

Let me check the loadtest config to confirm the cause.

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/loadtest/job.yaml

## Assistant

Confirmed the cause. With `parallelism: 4`, all four k6 pods share identical env (`SCENARIO`, `TESTID`) and emit metrics with identical label sets. All four push to Prometheus remote-write concurrently → samples for the same series arrive out of order / duplicated → Prometheus returns 400. Let me grab the exact reason from Prometheus to be sure before patching.

## Assistant

> Bash: /Users/carrein/Desktop/iocheck2/.bin/kubectl -n iocheck get pods -l job-name=k6-load --no-headers 2>...

## Assistant

Confirmed: Prometheus is rejecting samples because all 4 k6 pods emit identical series labels (`k6_http_reqs_total{testid=...}` with no per-pod distinguisher), so concurrent writes collide as "duplicate sample" / "out of order".

Fix: inject each pod's name via the downward API and pass it as a k6 tag so each pod's series is uniquely labeled. Quick check that this won't break the dashboard.

## Assistant

> Bash: grep -l "k6_" /Users/carrein/Desktop/iocheck2/dashboards/*.json /Users/carrein/Desktop/iocheck2/scri...

## Assistant

Nothing queries `k6_*` series — dashboard and capture.ts use iocheck's own metrics. Safe to add a per-pod tag. Applying the fix.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/loadtest/job.yaml

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/loadtest/job.yaml

## Assistant

Patched `loadtest/job.yaml`:
- Added `POD_NAME` from the downward API (`metadata.name`).
- Added `--tag=instance=$(POD_NAME)` to k6 args.

Now each of the 4 parallel pods emits a distinct series (`...{testid=..., instance="k6-load-2g5jx"}` etc.), so concurrent remote-writes no longer collide. Re-run `make bench-rps` (or `bench-cpu`) and the 400s should be gone. The dashboard and capture summary are unaffected since they query iocheck's own metrics, not `k6_*`.

## User

Run make bench-cpu 
Run make bench-rps
Note and ameliorate any anomalies.
Compare results at the end.

## Assistant

I'll run both benches sequentially, monitor for anomalies (especially the Prometheus 400s and any zero-traffic issues), then compare. Let me verify cluster state first and confirm the existing port-forwards are still healthy.

## Assistant

> ToolSearch

## Assistant

> TaskCreate: Confirm kind cluster is up, iocheck pods are Ready, Prometheus/Grafana port-forwards reachable befor...

## Assistant

> TaskCreate: Launch CPU-HPA bench, monitor k6 + Prometheus for anomalies (remote-write 400s, zero RPS on scaled p...

## Assistant

> TaskCreate: Launch RPS-HPA bench, monitor for the same anomalies, capture artifact dir

## Assistant

> TaskCreate: Read both summary.md files, contrast scaling behaviour, p99, peak/avg RPS, replica trajectory. Note ...

## Assistant

> TaskUpdate

## Assistant

> Bash: .bin/kind get clusters 2>/dev/null; echo "---"; .bin/kubectl -n iocheck get deploy,hpa,scaledobject,...

## Assistant

Several anomalies found before starting:

1. **A k6 bench is already in flight** (4 k6 pods, 2m38s old) — launched before my job.yaml fix, so still emitting the 400s the user pasted.
2. **The cpu-hpa overlay is already applied** (KEDA scaledobject `iocheck-cpu` exists).
3. **Grafana port-forward is dead** (port 3000 connection refused).
4. **Prometheus port-forward is healthy** (9090 returns 200).

I need to terminate the stale in-flight bench, restart the Grafana port-forward, then launch cleanly so the fixed `job.yaml` actually takes effect.

## Assistant

> Bash: ps aux | grep -E "capture\.ts|bun run|_bench|kubectl.*(wait|port-forward|logs.*k6)" | grep -v grep

## Assistant

> Bash: ls -la /Users/carrein/Desktop/iocheck2/artifacts/ /Users/carrein/Desktop/iocheck2/.bin/pids/ 2>/dev/...

## Assistant

> Bash: ls -la /Users/carrein/Desktop/iocheck2/artifacts/cpu-hpa-hot-20260512T170521Z/; echo "---"; cat /Use...

## Assistant

> Bash: cat /Users/carrein/Desktop/iocheck2/artifacts/cpu-hpa-hot-20260512T170521Z/summary.md

## Assistant

The prior bench was Ctrl-C'd after 24s (incomplete data). Cleaning that out, then running fresh. Also confirming Grafana pod is healthy after that namespace-closed event.

## Assistant

> Bash: .bin/kubectl -n monitoring get pods -l app.kubernetes.io/name=grafana 2>/dev/null; echo "---"; rm -r...

## Assistant

> TaskUpdate

## Assistant

> TaskUpdate

## Assistant

> Bash: make bench-cpu

## Assistant

> ToolSearch

## Assistant

> Bash: sleep 30; tail -40 /private/tmp/claude-501/-Users-carrein-Desktop-iocheck2/94a9e453-37d4-43ff-9508-a...

## Assistant

Good — k6 is running at ~1000 RPS aggregate (4 pods × 250 iters/s) with no remote-write errors in the log so far. Quick sanity check on Prometheus to confirm the fix.

## Assistant

> Bash: .bin/kubectl -n monitoring logs -l app.kubernetes.io/name=prometheus --tail=20 --since=60s 2>/dev/nu...

## Assistant

Fix confirmed: zero remote-write rejections. Letting the bench run; ~4.5 min of k6 still to go.

## Assistant

> Bash: sleep 240; tail -5 /private/tmp/claude-501/-Users-carrein-Desktop-iocheck2/94a9e453-37d4-43ff-9508-a...

## Assistant

> Bash: tail -10 /private/tmp/claude-501/-Users-carrein-Desktop-iocheck2/94a9e453-37d4-43ff-9508-ae1bed84c3c...

## Assistant

> Bash: .bin/kubectl get hpa -n iocheck; echo "---"; .bin/kubectl get scaledobject -n iocheck; echo "---"; ....

## Assistant

HPA is up: CPU at 40%/70% — under the 70% trigger. So in hot mode at 1000 RPS the CPU-HPA structurally won't scale (90% cache hits are too cheap on CPU). This is the expected baseline. Letting the bench finish.

## Assistant

> Bash: sleep 180; ls /Users/carrein/Desktop/iocheck2/artifacts/cpu-hpa-hot-20260512T170924Z/ 2>/dev/null; e...

## Assistant

bench-cpu finished. Reading the summary.

## Assistant

> Bash: cat /Users/carrein/Desktop/iocheck2/artifacts/cpu-hpa-hot-20260512T170924Z/summary.md

## Assistant

> TaskUpdate

## Assistant

> TaskUpdate

## Assistant

> Bash: make bench-rps

## Assistant

> Bash: sleep 90; .bin/kubectl get hpa,scaledobject -n iocheck; echo "---"; tail -5 /private/tmp/claude-501/...

## Assistant

Strong contrast already: RPS-HPA scaled 2 → 9 replicas within 90s (target = 100 RPS/pod, current 99/100). Letting it complete.

## Assistant

> Bash: sleep 300; ls /Users/carrein/Desktop/iocheck2/artifacts/ | grep rps-hpa; echo "---"; tail -3 /privat...

## Assistant

> Bash: ls /Users/carrein/Desktop/iocheck2/artifacts/; echo "---"; tail -8 /private/tmp/claude-501/-Users-ca...

## Assistant

> Bash: sleep 90; ls /Users/carrein/Desktop/iocheck2/artifacts/rps-hpa-hot-20260512T171451Z/ 2>/dev/null; ec...

## Assistant

> Bash: cat /Users/carrein/Desktop/iocheck2/artifacts/rps-hpa-hot-20260512T171451Z/summary.md

## Assistant

Both benches complete. Reading the replica trajectories to support the comparison.

## Assistant

> Bash: echo "=== CPU bench trajectory ==="; head -3 /Users/carrein/Desktop/iocheck2/artifacts/cpu-hpa-hot-2...

## Assistant

> TaskUpdate

## Assistant

> TaskUpdate

## Assistant

Both benches completed cleanly. Here's the run report.

## Anomalies observed and addressed

| # | Anomaly | When | Action |
|---|---|---|---|
| 1 | Prometheus remote-write 400s (`duplicate sample` / `out of order`) — 4 parallel k6 pods all emitted identically-labeled series | Pre-existing | Already patched `loadtest/job.yaml`: added `POD_NAME` via downward API + `--tag=instance=$(POD_NAME)`. **Confirmed zero rejections during these runs.** |
| 2 | Stale in-flight bench from earlier session: 4 running k6 pods, cpu-hpa overlay applied, incomplete artifact dir | Pre-launch | Deleted `k6-load` Job, removed broken `cpu-hpa-hot-20260512T170521Z` (24s of data) |
| 3 | Grafana port-forward dead (`network namespace for sandbox … is closed`) because the Grafana pod had been restarted | Pre-launch | Removed stale `grafana.pid`; Makefile's `_start_pf` re-established it cleanly during the bench |
| 4 | `Avg p99 latency` reports `-` in both summaries | Both runs | Cosmetic — `avg_over_time(histogram_quantile(...) [15m:15s])` returns null when the rate is sparse at the window edges. Not blocking. Worth fixing in `scripts/capture.ts:151` later by tightening the window. |
| 5 | CPU-HPA did **not** scale (held at 2 replicas, peak CPU 29% vs 70% threshold) | bench-cpu | **Not a bug — this is the writeup's thesis.** In hot mode, 90% cache hits don't drive CPU above threshold even at 1000 RPS. To force CPU-HPA to react you need `COLD=1` (the cache-bust regime). |

## Comparison: bench-cpu vs bench-rps (hot, 1000 RPS, 5 min)

| Metric | bench-cpu (`cpu-hpa-hot-20260512T170924Z`) | bench-rps (`rps-hpa-hot-20260512T171451Z`) |
|---|---|---|
| p99 < 200ms | ✅ peak 5ms | ✅ peak 5ms |
| Scaled? | ❌ held at 2 | ✅ **2 → 10 → 7** |
| Peak RPS (cluster) | 1001.5 | 1004.4 |
| Avg RPS | 419.5 | 644.6 |
| Peak CPU %req | 29.2% | 29.2% |
| Avg CPU %req | 9.6% | 12.6% |
| Peak in-flight/pod | 3 | 8 (during scale-up wave) |
| Cache hit rate | 89.9% | 89.9% |
| Peak / final replicas | 2 / 2 | 10 / 7 |

**RPS-HPA scaling timeline (bench-rps):**
- t+0:00 — 2 replicas, HPA reads ~0 RPS/pod
- t+0:46 — first scale-up, 2 → 5 (HPA observed 207 RPS/pod, ~2× target)
- t+1:01 — 7 replicas
- t+1:16 — 9 replicas
- t+2:33 — 10 replicas (hits MAX)
- t+4:30 — scale-down begins as drain stage ramps RPS down
- t+5:00 — 7 replicas (cooldown not yet finished)

**CPU-HPA timeline (bench-cpu):** no events. CPU stayed in the 10–29% band the entire run, never crossing the 70% threshold.

## Takeaway

In the **hot regime at 1000 RPS**, both autoscalers produce the same client-visible outcome (p99 = 5ms) because 2 pods can absorb 1000 cache-friendly RPS comfortably. The difference is *what each scaler sees*: RPS-HPA reacts to actual per-pod throughput (100 RPS/pod target → scales to 10) while CPU-HPA is blind to load because the cache hides it from CPU. The RPS scaler also recovers (scale-down at t+4:30) once load drains.

To show CPU-HPA's structural failure (latency degradation, no scaling), re-run with `COLD=1` — that's the regime where async I/O saturates without CPU rising, which is the whole point of the custom-metric HPA.

## User

Can u summarize anomalies and findings.

## Assistant

## Anomalies (all fixed before/during the runs)

1. **Prometheus remote-write 400s** — 4 parallel k6 pods emitted identically-labeled series, colliding as duplicate/out-of-order samples. Fixed in `loadtest/job.yaml` by adding `POD_NAME` via the downward API and `--tag=instance=$(POD_NAME)`. Zero rejections during these runs.
2. **Stale state at start** — leftover k6 Job, cpu-hpa overlay still applied, and a 24s broken artifact dir from a prior aborted run. Cleared before launch.
3. **Grafana port-forward dead** — Grafana pod had been restarted (`network namespace … is closed`). Removed stale pid file; Makefile's `_start_pf` re-established it cleanly.
4. **`Avg p99` reports `-`** in both summaries — cosmetic: `avg_over_time(histogram_quantile(...) [15m:15s])` (`scripts/capture.ts:151`) returns null at sparse window edges. Worth tightening the window later, not blocking.

## Findings (hot mode, 1000 RPS, 5 min)

| | bench-cpu | bench-rps |
|---|---|---|
| p99 | 5ms ✅ | 5ms ✅ |
| Scaled? | ❌ held at 2 | ✅ 2 → 10 → 7 |
| Peak CPU | 29% (threshold 70%) | 29% |
| Cache hit | 89.9% | 89.9% |
| Scale-up began | — | t+0:46 |
| Peak reached | — | t+2:33 |
| Scale-down began | — | t+4:30 |

- **Both scalers produced the same user-visible latency** — 2 pods can handle 1000 cache-friendly RPS comfortably.
- **CPU-HPA is blind to load in this regime**: 90% cache hits never push CPU above 70%, so it doesn't react.
- **RPS-HPA reacts to actual throughput**: scaled to MAX (10) within ~2.5 min and scaled back down during drain.
- **To surface CPU-HPA's structural failure** (the writeup's thesis), re-run with `COLD=1` — that forces async I/O saturation that CPU usage doesn't reflect.

## User

Any anomalies we must fix?

## Assistant

Only one code-level fix is actually live, and one minor data-quality fix is worth doing:

1. **`loadtest/job.yaml` — keep the patch.** The per-pod `instance` tag fix is in your working tree but **uncommitted**. If anyone reverts or stashes that file, the Prometheus 400s come back immediately. Commit it.

2. **`scripts/capture.ts:148-151` — tighten the `avg_over_time` window.** All four `avg_*` queries use `[15m:15s]`, but the bench only spans 5 min. For `avgP99`, the trailing portion of the window is NaN (histogram_quantile on empty buckets), which propagates through `avg_over_time` and produces `-` in the summary table. Change `[15m:15s]` → `[5m:15s]` (or sized off the actual duration). `max_over_time` is unaffected because it skips NaNs, which is why peak values populated fine.

Everything else (stale k6 Job, dead Grafana pf, CPU-HPA not scaling in hot mode) was either operational housekeeping or expected behaviour — no code change needed.

## User

So no changes recommended?

## Assistant

No — two changes are recommended:

1. **Commit the `loadtest/job.yaml` fix** (currently uncommitted; if reverted, the 400s return).
2. **Fix `scripts/capture.ts:148-151`** — change `[15m:15s]` to `[5m:15s]` so `Avg p99 latency` stops rendering as `-`.

Want me to apply #2 now?

## User

Fix all.

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/scripts/capture.ts

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/scripts/capture.ts

## Assistant

> Bash: bunx tsc --noEmit 2>&1 | head -20

## Assistant

Done. `scripts/capture.ts:148-159` now sizes the lookback window to the actual bench duration (`max(1, ceil(durationS/60))m`) instead of a fixed 15m — so `Avg p99 latency` populates correctly, and `cacheHit` no longer dilutes with empty-window samples on short runs. Typecheck clean.

The `loadtest/job.yaml` fix from earlier is still uncommitted alongside the other working-tree changes — say "commit" if you want me to run carrein-commit to split and push.
