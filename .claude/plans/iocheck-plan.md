# iocheck — Implementation Plan
Created: 2026-05-12
Last revised: 2026-05-13 (bench-all + four-way grid landed; see `bench-all-plan.md`)
Status: COMPLETE

## Context

Take-home challenge (`EXERCISE.md`): build a small **threat-intel IOC lookup
service** in TypeScript on Bun, deploy to a local **kind** Kubernetes cluster,
and demonstrate **custom-metric autoscaling** that beats a CPU-based HPA.
Assessed via a 30-min walkthrough where pods must visibly scale 2 → ~max → 2 in
response to a 10× RPS burst, while p99 stays under 200 ms.

**Hard requirements from EXERCISE.md:**
- `POST /lookup` (`{type, value}` → `{verdict, ioc?}`), `POST /ioc` (admin upsert), `GET /healthz` (liveness), `GET /readyz` (DB+cache reachable), `GET /metrics` (Prometheus)
- Persistent store keyed `(type, value)` with `source`, `score`, `added_at`
- Cache layer, read-through, TTL, **invalidate on upsert**
- p99 < 200 ms including during 10× RPS spikes
- Containerized, k8s manifests, liveness/readiness/startup probes, **PDB minAvailable ≥ 2**, resource requests + limits
- HPA driven by **a signal that actually correlates with the workload** (CPU 70% is documented to fail)

**Self-imposed constraints (Phase 1 design):**
1. Reproducible — assessor pulls repo, runs on Docker, minimal host deps
2. Bun runtime — use built-in TS, Bun.serve, bun:test, Bun.sql, Bun.redis where production-ready
3. Calibrated example — every value defensible, every load shape commented

**Calibrated values (final):**
- Pod resources: requests **300m CPU / 128Mi mem**, limits **1000m / 256Mi**
- Replicas: **min=2** for every overlay; **max=8** for `cpu-hpa` (matches the
  EXERCISE.md baseline of `min=2, max=8`); **max=4** for `rps-hpa-4` (tight
  ceiling); **max=8** for `rps-hpa-8` (moderate ceiling)
- HPA "bad" signal: **CPU 70% of request** (the exercise baseline)
- HPA "good" signal: **RPS = 100 / pod** via Prometheus trigger; in-flight per
  pod is the principled long-term alternative (writeup §5)
- Workload: **TARGET_RPS=1000** flat, **MISS_RATE=0.8** default (80% miss /
  20% hot). `MISS_RATE=0.1` is the hot-mix probe; `MISS_RATE=1.0` is the
  cache-bypass DB-saturation probe.
- k6 profile: **30s ramp + 90s sustain + 30s drain + 120s post-observe**
  (~5 min wall-clock per bench). 90s sustain is enough for the slowest
  autoscaler (CPU-HPA, ~80s to first scale) to react; 120s post-observe
  captures the first scale-down steps.
- DB pool per pod: **10**; cache TTL **5 min** (hits) / **60 s** (miss
  tombstones); seeded IOCs **10 000** (~100 hot keys queried 90% of the time)

---

## Research Summary

Full notes in `iocheck-research.md`. The findings that materially shaped this plan:

- **Bun.sql + Bun.redis** are production-ready for this use case (read-heavy
  lookups, simple upserts, GET/SET cache). Caveats documented; not blockers.
  Fallback to `porsager/postgres` / `ioredis` is one import-swap if needed.
- **prom-client@^15.1.2** works on Bun, but **must not call `collectDefaultMetrics()`** —
  it crashes on `monitorEventLoopDelay`. Hand-pick metrics; expose
  `server.pendingRequests` as the in-flight gauge.
- **Bun.serve** has **no built-in SIGTERM** handler and an aggressive **10s
  idleTimeout** that includes handler time. Must hand-wire the shutdown
  sequence (fail readyz → sleep → `server.stop()` → close pools) and raise
  idleTimeout for slow miss-path queries.
- **KEDA 2.19** via single-manifest install; `metricType: AverageValue` causes
  HPA to divide the metric by replica count internally — **PromQL must return
  cluster-total, not per-pod**. `cooldownPeriod` is N→0 only; N→1 stabilization
  lives under `advanced.horizontalPodAutoscalerConfig.behavior.scaleDown.stabilizationWindowSeconds`.
  `fallback.replicas` covers the "Prometheus down" failure mode.
- **kube-prometheus v0.17.0** (manifest, not chart) gives Prometheus + Grafana +
  Operator pre-wired. **Must patch the Prometheus CR with
  `enableRemoteWriteReceiver: true`** for k6 push to work — Prometheus 3.x
  silently 404s otherwise. Drop alertmanager + blackbox-exporter to fit a
  laptop RAM budget.
- **kind v0.31.0** with `kindest/node:v1.32.0`, 3 workers + 1 control-plane,
  `extraPortMappings` for NodePort access. `kind load docker-image iocheck:dev`
  after every rebuild. **No `:latest` tags** (pull-always footgun).
- **k6 v2.0.0** as an in-cluster Job — `ramping-arrival-rate` (open model,
  fixed RPS targets), **not** `ramping-vus`. Push metrics via
  `--out=experimental-prometheus-rw`.

---

## Approach

Single committed approach; no fork in the design. Alternatives belong in the
writeup, not the implementation.

**Architecture (logical):**

```
       ┌──────────┐  POST /lookup, /ioc          ┌─────────────┐
       │   k6     │ ───────────────────────────► │  iocheck    │
       │   Job    │                              │  Deployment │ ── /metrics ──► Prometheus ──► Grafana
       └──────────┘                              │  (replicas) │                       ▲
                                                 └─────┬───────┘                       │
                                                       │                               │
                                            cache hit  │  cache miss                   │ scrape
                                                       ▼                               │
                                                  ┌────────┐   miss   ┌────────────┐   │
                                                  │ Redis  │ ───────► │ Postgres   │   │
                                                  │ (TTL)  │          │ (StatefulSet)│ │
                                                  └────────┘          └────────────┘   │
                                                                                       │
                                                                ┌────────┐             │
                                                                │ KEDA   │ ─► HPA ─────┘
                                                                │ScaledObj│  (custom metric)
                                                                └────────┘
```

**Stack pin matrix (locked):**

| Component | Version | Source |
|---|---|---|
| Bun (runtime + base image) | `oven/bun:1.3-slim` | hub.docker.com/r/oven/bun |
| Postgres | `postgres:17-alpine` | hub.docker.com |
| Redis | `redis:7.4-alpine` | hub.docker.com |
| kind | v0.31.0 | github.com/kubernetes-sigs/kind |
| Kubernetes (in kind) | v1.32.0 | `kindest/node:v1.32.0` |
| KEDA | v2.19.0 (manifest) | `keda-2.19.0.yaml` |
| kube-prometheus | v0.17.0 | github.com/prometheus-operator/kube-prometheus |
| k6 | `grafana/k6:2.0.0` | hub.docker.com/r/grafana/k6 |
| prom-client | npm `^15.1.2` | npmjs.com/package/prom-client |

### Design priorities (in order)
1. **Reproducibility** — `make up` on a clean machine with only Docker installed
2. **Minimal code / simplicity** — small surface, no premature abstraction
3. **Explicit and traceable** — every YAML setting, every PromQL query, every magic number is commented or named
4. **Performance for the demo workload** — calibrated to make scale-up visible and scale-down convincing
5. **Readable by an assessor in one pass**

---

## Implementation phases

### Phase A — Service core (Bun + TypeScript)

Files: `package.json`, `bun.lock`, `tsconfig.json`, `src/{server,db,cache,metrics,lookup,admin,shutdown,types}.ts`

Built `bun init` skeleton with strict TS (`target: ESNext`, `moduleResolution:
Bundler`). `src/types.ts` declares `IOCType = 'ip' | 'domain' | 'sha256'`,
`IOC`, and the EXERCISE.md verdict response shape. `src/db.ts` wraps `Bun.sql`
with `max: 10`, named-prepared `findIoc(type, value)` and `upsertIoc(ioc)`
(with `ON CONFLICT (type, value) DO UPDATE`). `src/cache.ts` wraps `Bun.redis`
with `ioc:{type}:{value}` keys, 300s hit TTL, 60s miss-tombstone TTL, and
`del`-on-upsert invalidation. `src/metrics.ts` registers per-route counters
and histograms plus the `iocheck_inflight_requests` gauge sampled from
`server.pendingRequests`. `src/lookup.ts` implements the read-through path.
`src/admin.ts` checks an `X-Admin-Token` header against the `ADMIN_TOKEN`
env var. `src/server.ts` is `Bun.serve` with `routes`, timing middleware,
and a `readyz` that PINGs Redis + `SELECT 1`s Postgres with a 1s
last-known-good cache. `src/shutdown.ts` fails readyz → sleeps → calls
`server.stop()` → closes both pools.

### Phase B — Tests

Files: `tests/{setup,lookup,admin,metrics}.test.ts`

`setup.ts` is a preload that creates a per-run ephemeral schema
(`test_<uuid8>`), points `search_path` at it, and drops on exit. Suites skip
if `DATABASE_URL`/`REDIS_URL` aren't reachable (CI gate). `lookup.test.ts`
covers known-malicious vs unknown vs malformed body. `admin.test.ts` covers
auth, idempotency, and cache invalidation after upsert. `metrics.test.ts`
asserts `/metrics` shape and that counters increment correctly.

### Phase C — Dockerfile + dev compose

Multi-stage Dockerfile (`deps` → `runtime` on `oven/bun:1.3-slim`),
`USER bun`, HEALTHCHECK against `/readyz`, ENTRYPOINT
`["bun", "run", "src/server.ts"]`. `.dockerignore` excludes `tests/`,
`.claude/`, `logs/`, `manifests/`, `loadtest/`, `scripts/`, `node_modules/`.
`docker-compose.yml` is for host-side dev with bind-mounted `src/`.

### Phase D — k8s manifests (cluster + service + data plane)

Files: `kind-config.yaml`, `manifests/namespace.yaml`,
`manifests/iocheck/{deployment,service,pdb,configmap,secret,servicemonitor}.yaml`,
`manifests/postgres/{statefulset,secret,init-configmap,seed-job}.yaml`,
`manifests/redis/{deployment}.yaml`

`kind-config.yaml` is 3 workers + 1 control-plane with one `extraPortMappings`
for the iocheck NodePort. iocheck Deployment runs `iocheck:dev` with
`imagePullPolicy: IfNotPresent`, the calibrated 300m/128Mi requests +
1000m/256Mi limits, all three probe types, and pod anti-affinity (preferred,
hostname topology) so replicas spread across the 3 workers — that's
challenge #2 ("make sure pods share load"). PDB sets `minAvailable: 2`.
ServiceMonitor scrapes `/metrics` every 10s. Postgres StatefulSet uses
`postgres:17-alpine`, 2Gi PVC on kind's local-path provisioner,
`max_connections=200` (worst-case 8 pods × 10 pool = 80 conns + headroom).
The schema is in an init ConfigMap. Seed Job is idempotent
(`ON CONFLICT (type, value) DO NOTHING`). Redis is `redis:7.4-alpine` with
`--maxmemory 256mb --maxmemory-policy allkeys-lru --save ""` (ephemeral by
design — cache reconstructible from Postgres).

### Phase E — Observability (Prometheus + Grafana)

Files: `manifests/monitoring/{grafana-config,prometheus-cr-patch,prometheus-netpol-patch,prometheus-rbac-iocheck}.yaml`,
`dashboards/iocheck.json`

kube-prometheus v0.17.0 is `git clone`d into `.bin/` at `make up` time and
applied directly (alertmanager + blackbox stripped to fit RAM). Prometheus
CR is patched via `kubectl patch --type=merge` to enable
`remoteWriteReceiver`, drop retention to 6h, and shrink resources.
NetworkPolicy is patched so KEDA and the loadtest namespace can reach
Prometheus. Grafana is reconfigured for anonymous Admin access (no login
wall) with the iocheck dashboard set as the home page. The dashboard is
auto-imported by the Makefile.

### Phase F — KEDA autoscaling (Kustomize overlays)

Files: `manifests/overlays/{cpu-hpa,rps-hpa-4,rps-hpa-8}/{kustomization,scaledobject}.yaml`

KEDA `keda-2.19.0.yaml` is applied at `make up` time. Three wired overlays:

- **`cpu-hpa/`** — Scenario A, the "bad" autoscaler from EXERCISE.md.
  `cpu` trigger, `metricType: Utilization`, `value: "70"` (70% of request),
  min=2 max=8 (matches the EXERCISE.md prompt's exact baseline), no fallback
  (CPU is in-cluster). This overlay exists to make the failure mode
  *visible* — at our cache-heavy workload, CPU peaks at ~50–60% of request
  even during a 10× burst, so the HPA never fires.
- **`rps-hpa-4/`** — Scenario B-tight. Prometheus trigger, query
  `sum(rate(http_requests_total{service="iocheck"}[1m]))`,
  `metricType: AverageValue`, `threshold: "100"` (target 100 RPS/pod), min=2
  max=4 (tight horizontal ceiling), `fallback: {failureThreshold: 3,
  replicas: 3, behavior: currentReplicasIfHigher}`.
- **`rps-hpa-8/`** — Scenario B-moderate. Same as rps-hpa-4 but max=8 and
  fallback replicas=4. This is also the overlay used by `bench-failure`.

Inline comments in each ScaledObject explain the AverageValue/HPA
divide-by-replicas gotcha. Kustomize base under `manifests/iocheck/`;
overlays compose base + ScaledObject.

### Phase G — Load test (k6 in-cluster)

Files: `loadtest/{script.js,configmap.yaml,job.yaml}`

`loadtest/script.js` uses `ramping-arrival-rate` (open model) with stages
30s ramp → 90s sustain → 30s drain at the configured TARGET_RPS. Default
distribution is 80% miss / 20% hot keys (`MISS_RATE=0.8`); both pools
overlap with seeded IOCs so cache-hit accounting is honest. Thresholds:
`http_req_failed: ['rate<0.01']`, `http_req_duration: ['p(99)<200']`. k6
runs 4 parallel pods (one per worker plus control-plane) so its own CPU
doesn't bottleneck the load. Metrics push via
`--out=experimental-prometheus-rw` to the in-cluster Prometheus.

### Phase H — Makefile + reproducibility

Files: `Makefile`, `scripts/{bootstrap.sh,seed.ts,capture.ts,compare.ts}`,
`README.md`

Assessor surface = **7 Make targets**:
- `make up` — `kind create cluster`, load image, install KEDA +
  kube-prometheus, apply iocheck stack, run seed Job, import dashboard
- `make down` — destroy cluster + `.bin/`, keep `artifacts/`
- `make bench-cpu` — CPU-HPA scenario + load + capture
- `make bench-rps4` — RPS-HPA (max=4) + load + capture
- `make bench-rps8` — RPS-HPA (max=8) + load + capture
- `make bench-failure` — RPS-HPA + Prometheus blackout @ T+75s for 90s
  (writeup §4 fallback validation)
- `make bench-all` — runs cpu / rps4 / rps8 sequentially under a single
  `artifacts/bench-all-<ts>/` root and emits `comparison.md`. Excludes
  `bench-failure` (different question). Continue-on-failure, non-zero
  exit if any sub-bench failed. See `bench-all-plan.md` for design.

All `bench-*` targets default to `MISS_RATE=0.8`, `TARGET_RPS=1000`.
`scripts/capture.ts` polls Prometheus + the KEDA HPA's `ScalingActive`
condition every 5s and writes `state.csv`, `prometheus-snapshots.json`,
`hpa-events.txt`, `summary.md`, and `summary.json` (the last is what
`compare.ts` aggregates). Capture is SIGTERM-safe — partial bench data is
recoverable.

### Phase I — Writeup

Files: `WRITEUP.md` (~1–2 pages, markdown). User maintains by hand.

### Phase J — Demo dry-run

`make down && make up && make bench-cpu && make bench-rps8 && make bench-failure`
produces a visible CPU-never-scales artifact, a clean 2 → up → 2 RPS
trajectory, and a fallback fire moment captured in `summary.md`. Each
bench writes its own artifact dir; `bench-all` produces a side-by-side
`comparison.md`.

---

## Edge cases & error handling

- **Prometheus down** → KEDA `fallback.replicas: {3 for rps-hpa-4, 4 for
  rps-hpa-8}, behavior: currentReplicasIfHigher`. The `currentReplicasIfHigher`
  setting is critical: plain `static` would *shrink* the deployment to the
  fallback count if Prometheus dies during a burst, which is the opposite of
  what you want.
- **Postgres pool exhaustion** at scale → `PG_POOL_MAX=10` × 8 pods = 80
  conns; Postgres `max_connections=200` covers app + monitoring + admin
- **Redis down** → readyz fails (per EXERCISE.md spec). Service stops
  receiving traffic; cleanly recovers when Redis returns. We deliberately
  don't degrade to "DB-only mode" — that would be a silent SLA breach
- **Bun idleTimeout** → raised to 30s so slow miss-path queries don't reset
  connections under burst
- **SIGTERM** → drain pattern (readyz=false → sleep 5s → server.stop → pool
  close → exit). `terminationGracePeriodSeconds: 30` covers it
- **kind RAM budget** → strip alertmanager + blackbox-exporter; Prometheus
  retention=6h, replicas=1
- **Image not loaded into kind** → explicit `iocheck:dev` tag,
  `imagePullPolicy: IfNotPresent`, `make up` always runs `kind load docker-image`
- **KEDA AverageValue / replica-divide gotcha** → PromQL returns
  cluster-total; inline comment in YAML
- **`/ioc` auth** → shared `X-Admin-Token`; 401 on missing/wrong; deliberately
  not exposing existence
- **Seed Job concurrency** → `ON CONFLICT (type, value) DO NOTHING`;
  idempotent across reruns
- **Cache poisoning on upsert** → `cache.del` immediately after successful DB
  upsert; eventual consistency window is the gap between DB commit and Redis
  DEL (one network hop)
- **Negative cache for unknown IOCs** → short TTL (60s) tombstone to absorb
  miss-path bursts on the same unknown value; expires fast enough not to
  mask a fresh upsert
- **`/lookup` body validation** → reject anything that isn't the documented
  shape with 400; missing `type` or unrecognized type returns 400 (don't 500
  on bad input)

---

## Risks & open questions (resolution status)

1. **CPU calibration** (RESOLVED) — measured ~0.12 ms/hit, lower than
   estimated. CPU stays well under 70% during bursts; "wrong signal"
   narrative holds even more strongly than expected.
2. **kind RAM ceiling on a laptop** (RESOLVED) — 3 workers + full stack
   fits within 4–6 GB. Stripped alertmanager and blackbox to make headroom.
3. **Bun.sql sharp edges** (RESOLVED) — none bit this exercise. Kept
   `porsager/postgres` as a one-import swap, never needed.
4. **HPA scale-down stabilization tuning** (RESOLVED) — settled at 60s
   stabilization + 25%/60s policy. Drains a full burst back to min=2 inside
   the 120s post-observe window.
5. **k6 push to Prometheus** (RESOLVED) — `enableRemoteWriteReceiver: true`
   patch on the Prometheus CR; verified in artifacts.
6. **Per-pod load balance** (RESOLVED) — k6 ClusterIP traffic distributes
   within ±10% across pods (verified via per-pod `http_requests_total`).
7. **30-min walkthrough timing** (RESOLVED) — `make up` ~6 min;
   `bench-rps8` ~5 min; total fits a live demo with margin. Pre-warm `up`
   before the call.

---

## Build Log

**2026-05-12** — initial implementation. Service, tests, Docker, k8s
manifests, kube-prometheus, KEDA, k6, Makefile, README, WRITEUP all built
and verified end-to-end.

**2026-05-13** — bench harness evolution. Added the four-way bench grid
(`bench-cpu`, `bench-rps4`, `bench-rps8`, `bench-failure`) replacing the
original single `bench-rps` target; tightened the k6 profile from 10 min
to ~5 min; switched KEDA fallback from `static` to
`currentReplicasIfHigher`; added `bench-all` aggregator (separate plan
doc: `bench-all-plan.md`).

### Notable deviations from the original plan
- **`extraPortMappings` for Prometheus + Grafana removed.** Docker binds
  the host port the moment the container starts even without a matching
  NodePort Service, shadowing `kubectl port-forward` binds. Kept the
  iocheck NodePort 30080→8080 mapping; Grafana + Prometheus access goes
  via Makefile port-forwards.
- **Prometheus `serviceMonitorNamespaceSelector` is `{}`, not
  label-restricted.** An earlier draft restricted to `monitoring=true`,
  which excluded the `monitoring` namespace itself and silently broke
  kubelet/cadvisor scraping (and thus CPU-based HPA). Made the selector
  empty.
- **Prometheus NetworkPolicy patched** (`prometheus-netpol-patch.yaml`).
  Upstream kube-prometheus allows only Grafana + adapter ingress.
  Extended to permit the `keda` namespace (autoscaler queries) and the
  loadtest namespace (k6 remote-write push).
- **Prometheus CR patch via `kubectl patch --type=merge`, not `apply -f`.**
  `apply -f` clobbers `podMetadata.labels` because the
  last-applied-config replaces the entire spec; the operator then can't
  populate the Service selector and the Service has zero endpoints.
- **prometheus-operator rollout restart in `.stack`.** The operator caches
  the namespace list; without a forced re-sync after iocheck namespace
  creation, the iocheck ServiceMonitor never produces a scrape job.
- **Seed Job env-var ordering.** `$(PGPASSWORD)` substitution in
  `DATABASE_URL` requires PGPASSWORD to be declared *before* DATABASE_URL
  in the env list — k8s only substitutes from prior entries.
- **Makefile inline `#` comments removed inside the bench heredoc.**
  A `# comment \` after a chained shell command swallowed the rest of the
  bench cleanup section because make joins recipe lines into one shell
  string before the shell sees them.
- **Postgres CPU bumped from 200m to 1000m.** At 200m, Postgres got
  starved on cpu.shares by iocheck pods on the same kind worker; bumped
  to give it real scheduling priority.
- **Redis CPU bumped from 50m to 500m + 2000m limit.** Same root cause —
  single-threaded Redis was being descheduled under pod contention,
  showing 10–60ms ops in slowlog.

## Summary

Files created/modified: ~50 across `src/`, `tests/`, `scripts/`,
`manifests/`, `loadtest/`, `dashboards/`, plus the top-level
`Dockerfile`, `docker-compose.yml`, `kind-config.yaml`, `Makefile`,
`README.md`, `WRITEUP.md`. Bench artifacts are generated per run under
`artifacts/<scenario>-<mode>-<ts>/` (or `artifacts/bench-all-<ts>/<scenario>/`
when run via `bench-all`) and are not committed.

Key decisions worth recalling:
- Bun.serve + Bun.sql + Bun.redis (no external drivers).
- KEDA + Prometheus over prometheus-adapter for the autoscaler.
- kube-prometheus v0.17.0 vendored at `make up` time (git clone into
  `.bin/`).
- Bench captures via `scripts/capture.ts`: replica trajectory CSV, PromQL
  snapshots, summary.md, summary.json, HPA describe — all written on
  capture's SIGTERM handler so partial bench data is recoverable.
- KEDA `fallback.behavior: currentReplicasIfHigher` so a Prometheus blackout
  during a burst doesn't shrink the deployment.
