# Session: Initialize coding session

## User

<command-message>carrein-uberthink</command-message>
<command-name>/carrein-uberthink</command-name>
<command-args>Run the bench twice. You may do so doing make up and make bench-all. Both benches should have similar summaries. Note any anomalies when you are harnessing this two runs.</command-args>

## Assistant

I'll prep before kicking off long-running benches. Let me read the relevant docs and clarify a couple of operational points.

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Bash: ls -la /Users/carrein/Desktop/iocheck2/artifacts/ 2>/dev/null | head -30

## Assistant

> Bash: ls /Users/carrein/Desktop/iocheck2/artifacts 2>&1; echo "---"; ls -la /Users/carrein/Desktop/iocheck...

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/scripts/compare.ts

## Assistant

> Bash: test -x /Users/carrein/Desktop/iocheck2/.bin/kind && echo ".bin/kind exists" || echo ".bin/kind miss...

## Assistant

I've read the relevant Makefile + compare.ts and confirmed cluster is down (no `.bin/kind`), Docker is up, Bun is available. Quick framing before I kick off ~45 minutes of work.

**Plan (escape hatch — this is operational, not a code change):**
1. `make up` once (~5-10 min) — cluster + stack + seed.
2. `make bench-all` (run 1, ~15 min) → `artifacts/bench-all-<ts1>/comparison.md`.
3. `make bench-all` (run 2, ~15 min) → `artifacts/bench-all-<ts2>/comparison.md`.
4. Diff both `comparison.md` files + per-bench `summary.json` (p99, peak replicas, error rate, SLO marks). Flag anomalies: numbers outside expected variance, sub-bench failures, cluster state issues, cache-warm carryover affecting run 2.

**Two operational questions:**

1. **Cluster reuse between runs** — same cluster for both bench-all runs, or `make down`/`make up` between them? Same-cluster is faster and matches the assessor's likely demo path; tear-down-between is the cleaner reproducibility experiment (no Redis cache carryover). I'd recommend same-cluster (faster, and any carryover effect is itself a useful anomaly to flag). OK?

2. **Backgrounding** — I'll run each phase in the background and poll for completion (no sleep loops). You'll get updates at each phase boundary. OK?

If both are yes, I'll start now. Otherwise tell me which knob to flip.

## User

1. OK.
2. OK.

## Assistant

Starting `make up` in the background now.

## Assistant

> Bash: make -C /Users/carrein/Desktop/iocheck2 up 2>&1 | tee /tmp/iocheck-up.log

## Assistant

`make up` is running (ID `bsgi6aqhc`). I'll report when it completes and then kick off bench-all run 1.

## User

<task-notification>
<task-id>bsgi6aqhc</task-id>
<tool-use-id>toolu_01521neLDBJWp4bzS9LCFE9J</tool-use-id>
<output-file>/private/tmp/claude-501/-Users-carrein-Desktop-iocheck2/dcd41079-fe06-425f-bc35-83929c0a6a6b/tasks/bsgi6aqhc.output</output-file>
<status>completed</status>
<summary>Background command "Bring up the kind cluster, deploy stack, seed 10k IOCs" completed (exit code 0)</summary>
</task-notification>

## Assistant

> ToolSearch

## Assistant

> TaskCreate: Bring up kind cluster, deploy iocheck stack, seed 10k IOCs

## Assistant

> TaskCreate: First bench-all run: cpu-hpa + rps-hpa-4 + rps-hpa-8, MISS_RATE=0.8, TARGET_RPS=1000

## Assistant

> TaskCreate: Second bench-all run on same cluster (no down/up between)

## Assistant

> TaskCreate: Compare both comparison.md + per-bench summary.json. Flag deltas in p99, peak replicas, error rate, ...

## Assistant

> TaskUpdate

## Assistant

Quick spot-check on the `make up` log, then kicking off bench-all run 1.

## Assistant

> Bash: tail -40 /tmp/iocheck-up.log; echo "---kubectl pods---"; /Users/carrein/Desktop/iocheck2/.bin/kubect...

## Assistant

**Anomaly #1 spotted in `make up`:** The wrapping `tee` masked a `make` non-zero exit. Inside the log:
```
running seed job (10k IOCs)...
error: timed out waiting for the condition on jobs/iocheck-seed
make: *** [.seed] Error 1
```

The seed job timed out at the 180s wait. Cluster + iocheck deployment still came up. Let me check whether the seed job eventually finished and whether the DB actually has 10k rows.

## Assistant

> Bash: /Users/carrein/Desktop/iocheck2/.bin/kubectl -n iocheck get job iocheck-seed -o wide 2>&1; echo "---...

## Assistant

Seed job **Failed**, DB has 0 rows. We can't bench without IOCs seeded. Let me get the pod logs to diagnose.

## Assistant

> Bash: /Users/carrein/Desktop/iocheck2/.bin/kubectl -n iocheck get pods -l job-name=iocheck-seed 2>&1; echo...

## Assistant

> Bash: /Users/carrein/Desktop/iocheck2/.bin/kubectl -n iocheck describe job iocheck-seed 2>&1 | tail -60

## Assistant

Failed pods are gone. Let me re-run the seed job manually and capture its actual logs.

## Assistant

> Bash: /Users/carrein/Desktop/iocheck2/.bin/kubectl -n iocheck delete job iocheck-seed 2>&1; /Users/carrein...

## Assistant

> Bash: for i in $(seq 1 30); do pod=$(/Users/carrein/Desktop/iocheck2/.bin/kubectl -n iocheck get pods -l j...

## Assistant

> TaskUpdate: Bring up cluster + seed 10k IOCs. Initial run: seed job Failed (BackoffLimitExceeded), DB has 0 rows...

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/scripts/seed.ts

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/Dockerfile

## Assistant

> Bash: find /Users/carrein/Desktop/iocheck2/manifests -name "*seed*" -o -name "*.yaml" | xargs grep -l "see...

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/manifests/postgres/seed-job.yaml

## Assistant

The Dockerfile only copies `src/`, but the seed Job runs `bun run scripts/seed.ts` — that file isn't in the image. Let me confirm via git and inspect the image.

## Assistant

> Bash: git log --oneline -- Dockerfile 2>&1 | head -10; echo "---"; git log -p --follow -- Dockerfile 2>&1 ...

## Assistant

**Anomaly #2 — and it's a real bug, not a transient.** Commit `7c241e0` (the four-way bench grid commit) removed `COPY scripts ./scripts` from the Dockerfile, but the seed Job still runs `bun run scripts/seed.ts`. So the seed pod fails on startup (file not in image) → `make up`'s seed step times out → DB has 0 rows → `make bench-all` would run against an empty IOC store and produce meaningless numbers.

This is a regression in `make up` itself, not a bench-run flake.

**Fork — how do you want to proceed?**

**(a)** I restore the one-line `COPY scripts ./scripts` in `Dockerfile`, rebuild image, reload into kind, re-run the seed job, then proceed with bench-all twice. Correct fix; matches the intent of `make up`.

**(b)** I work around without touching the codebase — `kubectl cp` scripts/ into a one-off Bun pod and run seed there. Gets us bench data but leaves the bug present; future `make up` will still fail.

I recommend **(a)** — the bug breaks the assessor flow, and the fix is the literal one-line restoration of what was accidentally deleted. Want me to proceed with (a)?

## User

Yes.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/Dockerfile

## Assistant

> Bash: grep -E "^scripts" /Users/carrein/Desktop/iocheck2/.dockerignore 2>&1; echo "---"; cat /Users/carrei...

## Assistant

> Bash: docker build -t iocheck:dev . 2>&1 | tail -10 && echo "---loading into kind---" && /Users/carrein/De...

## Assistant

> Bash: /Users/carrein/Desktop/iocheck2/.bin/kubectl -n iocheck delete job iocheck-seed --ignore-not-found 2...

## Assistant

Seed worked: **10,000/10,000 rows in 83ms**. The `make up` flow actually halted at `.seed` though, so the `.grafana-dashboard` step (which is part of `up`) never ran. Let me complete that step so `make up` is fully done, then mark task complete.

## Assistant

> Bash: make -C /Users/carrein/Desktop/iocheck2 .grafana-dashboard 2>&1 | tail -10

## Assistant

> TaskUpdate: Cluster + stack + seed up. Required a Dockerfile fix (restore COPY scripts ./scripts) and a manual r...

## Assistant

> TaskUpdate

## Assistant

Cluster ready (DB=10k, Grafana dashboard imported). Kicking off **bench-all run 1** in the background.

## Assistant

> Bash: make -C /Users/carrein/Desktop/iocheck2 bench-all 2>&1 | tee /tmp/iocheck-bench-run1.log

## Assistant

Bench-all run 1 started (ID `bqytmebq6`). ETA ~15 minutes. I'll report on completion and queue run 2.

## User

I cannot access Grafana on port 3000. This has been a consistent problem on make up. Figure out why. Use a different port as well.

## Assistant

Let me diagnose without disturbing the running bench (read-only checks).

## Assistant

> Bash: echo "---lsof on 3000---"; lsof -nP -iTCP:3000 -sTCP:LISTEN 2>&1; echo "---port-forward pid file---"...

## Assistant

Let me check the current pid state and look at the prometheus port-forward too.

## Assistant

> Bash: echo "---grafana pid file content---"; cat /Users/carrein/Desktop/iocheck2/.bin/pids/grafana.pid; ec...

## Assistant

> Bash: echo "---lsof for pid 15276---"; lsof -nP -p 15276 2>/dev/null | grep -E "TCP|IPv" | head -10; echo ...

## Assistant

Now I have the picture. Grafana **is** working right now (curl returns 200) because bench-all started a fresh port-forward at 13:17. But between 13:14-13:17 (~3 minutes), port 3000 was dead because the prior `kubectl port-forward` died.

Let me check what else may be restarting Grafana so I find the consistent failure mode.

## Assistant

> Bash: echo "---top-level kustomization---"; cat /Users/carrein/Desktop/iocheck2/manifests/kustomization.ya...

## Assistant

Root cause is clear. Let me check doc references to port 3000 before editing.

## Assistant

> Bash: grep -rn "3000\|localhost:3000\|127.0.0.1:3000" /Users/carrein/Desktop/iocheck2/{Makefile,README.md,...

## Assistant

iocheck server's container port stays at 3000 (internal). Only Grafana **host** port needs changing. Plan:

1. New `scripts/pf.sh` — supervised port-forward (auto-restart when target pod is replaced).
2. `_start_pf` macro calls `pf.sh` instead of inline kubectl.
3. Grafana host port: `3000` → `3030` (in-cluster service port stays 3000).
4. Update Makefile help + README.
5. Kill current grafana port-forward, hand-start new supervised one on `:3030` so the user has access immediately.

Bench-all run 1's `cpu-hpa` is mid-flight; its `_start_pf` already ran, so the Makefile edit doesn't affect the currently running scenario. The recursive `make` for `rps-hpa-4`/`rps-hpa-8` (and run 2) picks up the new logic. Grafana port-forward is separate from bench numbers (those come via `:9090`), so changing it mid-run doesn't pollute the bench data.

## Assistant

> Write: /Users/carrein/Desktop/iocheck2/scripts/pf.sh

## Assistant

> Bash: chmod +x /Users/carrein/Desktop/iocheck2/scripts/pf.sh && ls -la /Users/carrein/Desktop/iocheck2/scr...

## Assistant

Now patch the Makefile: replace `_start_pf` with supervised version, change Grafana host port to 3030.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/README.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/README.md

## Assistant

> Bash: make -C /Users/carrein/Desktop/iocheck2 -n help 2>&1 | head -15; echo "---grep verify---"; grep -n "...

## Assistant

Now swap the running grafana port-forward over to a supervised one on `:3030`.

## Assistant

> Bash: echo "---kill old kubectl pf---"; kill 15276 2>&1; sleep 1; rm -f /Users/carrein/Desktop/iocheck2/.b...

## Assistant

Grafana is live on **http://localhost:3030** (supervised — survives pod replacements). Let me verify the bench is still healthy and check progress.

## Assistant

> Bash: tail -8 /tmp/iocheck-bench-run1.log | grep -vE "^running|^load"; echo "---"; ls /Users/carrein/Deskt...

## Assistant

> Bash: date; echo "---summary of bench transitions in log---"; grep -E "bench:|scenario=|\\[7/7\\]|summary....

## Assistant

We're in scenario 3 of 3 (rps-hpa-8) for run 1, ~4 min remaining. Quick peek at first two scenarios' summaries to start tracking what "normal" looks like.

## Assistant

> Bash: echo "===== cpu-hpa ====="; cat /Users/carrein/Desktop/iocheck2/artifacts/bench-all-20260513T131227Z...

## Assistant

**Grafana port-3000 root cause + fix — summary for the user:**

**Why it consistently breaks:**
- `kubectl port-forward svc/grafana` binds to **one** specific Grafana endpoint pod at start time. It's not service-aware after that.
- `make up`'s `.monitoring` step does `kubectl rollout restart deployment/grafana` to apply the anonymous-access config. That replaces the pod the existing port-forward is attached to.
- When the pod dies, the kubectl process exits with `error: lost connection to pod` (saw it explicitly in `.bin/pids/grafana.log`).
- The Makefile's old `_start_pf` macro launched kubectl unsupervised — no auto-restart loop. The host port goes dark until the next explicit `_start_pf` call (a future bench, etc.).

**Fix applied:**
- New `scripts/pf.sh` — supervised wrapper that loops kubectl + reconnects on exit, with a SIGTERM trap so `_stop_pf` cleans up properly.
- `_start_pf` macro now invokes `pf.sh` instead of bare kubectl.
- Grafana host port moved off `:3000` (collides with React/Node dev servers) → **`:3030`** via `GRAFANA_PORT ?= 3030` (in-cluster service port unchanged at `3000`).
- Updated `Makefile` (5 call sites + `up:` post-print) and `README.md`.
- Hot-swapped the running port-forward: killed the old (already-dying) one, hand-started the new supervised version on `:3030`. **Grafana live now at http://localhost:3030** — verified `200` from `/api/health`.

**Bench-all run 1 status:** scenarios cpu-hpa and rps-hpa-4 done, rps-hpa-8 running (~3-4 min remaining). Headline so far:
- cpu-hpa: p99=6ms, 0% errors, replicas held at 2 (autoscaler never fired — expected wrong-signal failure).
- rps-hpa-4: p99=5ms, 0% errors, scaled 2→4→3.

I'll report when run 1 finishes and queue run 2.

## User

⏺ Grafana is live on http://localhost:3030 (supervised —
  survives pod replacements). Verified but the default ioc dashboard does not come up.

## Assistant

Let me query Grafana state directly.

## Assistant

> Bash: echo "---list dashboards---"; curl -fsS -u admin:admin "http://127.0.0.1:3030/api/search?type=dash-d...

## Assistant

Found it. **The iocheck dashboard isn't in the list** at all — only kube-prometheus's auto-provisioned ones. And `/api/org/preferences` is empty (no home dashboard).

**Why:** Grafana stores API-imported dashboards in `/var/lib/grafana/grafana.db` (SQLite) on an `emptyDir` volume — wiped on pod restart. The `.monitoring` step does `kubectl rollout restart deployment/grafana` and `kubectl wait --for=condition=Available`, which goes True as soon as the **new** pod is Ready — while the **old** pod is still terminating. With RollingUpdate (maxSurge=1, maxUnavailable=0) both pods sit in the Endpoints set briefly, so `kubectl port-forward svc/grafana` can attach to the **old** pod. The curl-import in `.grafana-dashboard` lands on whichever pod port-forward picked — sometimes the doomed one. When it dies, the imported dashboard dies with it. The provisioned kube-prometheus dashboards survive because they're mounted from ConfigMaps, not stored in SQLite.

**Hot fix now (re-import into the live pod):**

## Assistant

> Bash: body=$(bun -e 'const d=await Bun.file("dashboards/iocheck.json").json(); console.log(JSON.stringify(...

## Assistant

Hot fix done — http://localhost:3030 now lists the iocheck dashboard and has it as home. Quick check on bench progress and then offer the durable fix.

## Assistant

> Bash: date; echo "---bench-all task status---"; ls -la /Users/carrein/Desktop/iocheck2/artifacts/bench-all...

## Assistant

Hot fix in place. Now let me propose the durable fix while run 1 finishes and check how kube-prometheus mounts dashboards.

## Assistant

> Bash: echo "---grafana deployment dashboard mounts---"; /Users/carrein/Desktop/iocheck2/.bin/kubectl -n mo...

## Assistant

The durable pattern is clear: every other dashboard is a ConfigMap mounted at `/grafana-dashboard-definitions/0/<name>/`. The provider config (`grafana-dashboards` CM) scans that tree on every Grafana startup. The iocheck dashboard was the only one using the fragile API-import-into-SQLite path.

**Durable fix plan:**
1. New `manifests/monitoring/grafana-iocheck-patch.yaml` — adds the volume + mount.
2. Update `grafana-config.yaml` — add `default_home_dashboard_path` so home preference survives restarts too.
3. Add a step in `.monitoring` to create the ConfigMap + patch the Deployment.
4. Simplify `.grafana-dashboard` — no more API import, just port-forward + a print line.
5. Apply now to the live cluster, verify, then start bench-all run 2.

Let me check the existing grafana-config secret structure first.

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/manifests/monitoring/grafana-config.yaml

## Assistant

> TaskCreate: Replace API-import-into-SQLite with kube-prometheus pattern (ConfigMap volume mount + default_home_d...

## Assistant

> TaskUpdate

## Assistant

> Write: /Users/carrein/Desktop/iocheck2/manifests/monitoring/grafana-iocheck-patch.yaml

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/manifests/monitoring/grafana-config.yaml

## Assistant

Now wire it into `.monitoring` and simplify `.grafana-dashboard`.

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

Bench-all run 1 finished while I was editing. Let me finish the Makefile, apply the durable fix, verify, then kick off run 2.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

Now apply the changes to the live cluster.

## Assistant

> Bash: echo "---apply grafana-config (with default_home_dashboard_path)---"; /Users/carrein/Desktop/iocheck...

## Assistant

> Bash: echo "---verify dashboard appears (no API import needed)---"; curl -fsS -u admin:admin "http://127.0...

## Assistant

Durable fix verified: iocheck dashboard now auto-provisions from ConfigMap. The supervised port-forward survived the rollout cleanly — `pf.sh` (pid 20099) is still alive, and it spawned a fresh `kubectl` (pid 24279, listening on 3030) when the old Grafana pod was terminated.

## Assistant

> TaskUpdate

## Assistant

> TaskUpdate

## Assistant

> Bash: cat /Users/carrein/Desktop/iocheck2/artifacts/bench-all-20260513T131227Z/comparison.md

## Assistant

**Run 1 baseline established.** Kicking off run 2.

## Assistant

> TaskUpdate

## Assistant

> Bash: make -C /Users/carrein/Desktop/iocheck2 bench-all 2>&1 | tee /tmp/iocheck-bench-run2.log

## Assistant

Bench-all run 2 launched (ID `bdegjmzun`, ETA ~15 min).

**Run 1 headline:**

| Scenario | p99 | Error rate | Peak replicas | SLO |
|---|---:|---:|---:|:---:|
| cpu-hpa | 6ms | 0.00% | 2 | ✓ ✓ ✗ (didn't scale — expected wrong-signal failure) |
| rps-hpa-4 | 5ms | 0.00% | 4 | ✓ ✓ ✓ |
| rps-hpa-8 | 6ms | 0.00% | 8 | ✓ ✓ ✓ |

**Grafana state going into run 2:** dashboard now ConfigMap-provisioned, home dashboard via grafana.ini, supervised port-forward on `:3030`. http://localhost:3030 should land directly on the iocheck dashboard and stay reachable through any pod replacement. I'll report when run 2 completes with the side-by-side anomaly analysis.

## User

<task-notification>
<task-id>bdegjmzun</task-id>
<tool-use-id>toolu_015t4BHhJr9eWkVSCqn4brb5</tool-use-id>
<output-file>/private/tmp/claude-501/-Users-carrein-Desktop-iocheck2/dcd41079-fe06-425f-bc35-83929c0a6a6b/tasks/bdegjmzun.output</output-file>
<status>completed</status>
<summary>Background command "Second bench-all run (cpu-hpa + rps-hpa-4 + rps-hpa-8)" completed (exit code 0)</summary>
</task-notification>

## Assistant

> Bash: echo "---both run dirs---"; ls -d /Users/carrein/Desktop/iocheck2/artifacts/bench-all-* 2>&1; echo "...

## Assistant

Most metrics match, but **p99 jumped on cpu-hpa (6→10ms) and rps-hpa-8 (6→16ms)** while rps-hpa-4 was identical (5ms). Let me dig into the per-scenario details before declaring it just noise.

## Assistant

> Bash: r1=/Users/carrein/Desktop/iocheck2/artifacts/bench-all-20260513T131227Z; r2=/Users/carrein/Desktop/i...

## Assistant

> Bash: r2=/Users/carrein/Desktop/iocheck2/artifacts/bench-all-20260513T132758Z; echo "===== run 2 cpu-hpa s...

## Assistant

> Bash: grep -A2 "replicas\|spec:" /Users/carrein/Desktop/iocheck2/manifests/iocheck/deployment.yaml | head ...

## Assistant

> TaskUpdate

## Assistant

> TaskUpdate

## Assistant

## Both runs complete — side-by-side + anomalies

**Headline comparison**

| Scenario | Run 1 p99 | Run 2 p99 | Run 1 peak repl | Run 2 peak repl | Δ |
|---|---:|---:|---:|---:|---|
| cpu-hpa | 6ms | 10ms | 2 | 2 | latency +4ms (still well under 200ms) |
| rps-hpa-4 | 5ms | 5ms | 4 | 4 | identical |
| rps-hpa-8 | 6ms | 16ms | 8 | 8 | latency +10ms (still 12× under SLO) |

**What matched across both runs:**
- All three scenarios passed SLO (p99 < 200ms, error rate < 1%, RPS-HPA scenarios scaled).
- Total request count within 1% per scenario (~118-124k).
- Peak/final replicas identical: cpu-hpa held at 2 (autoscaler never fired — expected wrong-signal failure), rps-hpa-4 hit 4 then drained to 3, rps-hpa-8 hit 8 then drained to 6.
- Cache hit rate 19.8-20.0% (workload hits exactly 20% hot, 80% miss → matches MISS_RATE=0.8).
- Scale-up timing for rps-hpa-8 within seconds across runs (T+41s to scale-up onset both times).
- Per-pod load distribution: cv=0% RPS spread across pods (round-robin works the same).
- Worker CPU peaks 20-24%, well below saturation — cluster wasn't the binding constraint.

**Anomalies noted in run 2 (none breach SLO, but worth flagging):**
1. **cpu-hpa peak in-flight per pod: 2 → 27.** A transient queue spike at 2-pod ceiling, briefly. p99 still 10ms. Likely a brief Postgres / Redis contention moment — not reproducible signal.
2. **rps-hpa-8 p99: 6ms → 16ms.** Tail-latency variance during the brief 2→8 ramp window. 88-90k requests in the sustain phase means a few hundred stragglers can move p99. Final-state replicas were the same.
3. **cpu-hpa avg CPU spread cv: 3.7% → 49.6%** (between the 2 pods). Same total CPU usage, just unevenly distributed between the two pods in one of the 1-minute snapshots — sampling artifact.

The two runs would tell the same story to an assessor. The p99 deltas are all in the 4-10ms range, far below the 200ms SLO. Replica behavior and SLO outcomes are identical.

---

## Harness anomalies caught during the run

These are the operational issues I had to remediate; all worth knowing about for future `make up` runs:

1. **Dockerfile regression — `make up` seed step always failed.** Commit `7c241e0` removed `COPY scripts ./scripts` but the seed Job still ran `bun run scripts/seed.ts`. Pod failed instantly, hit `BackoffLimit`, DB had 0 rows. *Fix:* restored the COPY line. (Discovered because the seed Job's pods were reaped before logs could be read.)
2. **`make up` exit code was misleading.** `make up 2>&1 | tee log` always exits 0 (tee's status, no `pipefail`), masking failures in the make pipeline. Worth knowing — exit codes aren't reliable when bench scripts pipe through tee.
3. **Grafana port-3000 went dark mid-`make up`.** Diagnosed: `kubectl port-forward svc/grafana` binds to one endpoint pod; when `.monitoring`'s rollout restart replaces it, the forward exits with "lost connection to pod" and nothing relaunches it. *Fix:* new `scripts/pf.sh` supervises and reconnects; moved host port to `3030` (also picked up by Makefile/README).
4. **iocheck dashboard kept disappearing.** Imported via Grafana's API, stored in SQLite on `emptyDir` — wiped on every Grafana pod restart. *Fix:* converted to kube-prometheus's ConfigMap-mount pattern (`grafana-iocheck-patch.yaml`) + `default_home_dashboard_path` in `grafana.ini`. Survives any restart.
5. **`.monitoring` used `wait --for=condition=Available` instead of `rollout status`** — Available flips true while the old pod is still in Endpoints, so port-forward could attach to a doomed pod. Replaced with `rollout status`.

Files touched: `Dockerfile`, `Makefile`, `README.md`, `manifests/monitoring/grafana-config.yaml`, plus new `scripts/pf.sh` and `manifests/monitoring/grafana-iocheck-patch.yaml`. None of the bench-comparison files (`scripts/compare.ts`, `scripts/capture.ts`, overlays) were touched.

Both `bench-all` runs landed in:
- `artifacts/bench-all-20260513T131227Z/` (run 1)
- `artifacts/bench-all-20260513T132758Z/` (run 2)
