# iocheck — Implementation Plan
Created: 2026-05-12
Status: COMPLETE

## Context

Take-home challenge (`EXERCISE.md`): build a small **threat-intel IOC lookup service** in TypeScript on Bun, deploy to a local **kind** Kubernetes cluster, demonstrate **custom-metric autoscaling** that beats a CPU-based HPA. Assessed via a 30-min walkthrough where pods must visibly scale 2 → ~10 → 2 in response to a 10× RPS burst, while p99 stays under 200 ms.

**Hard requirements from EXERCISE.md:**
- `POST /lookup` (`{type, value}` → `{verdict, ioc?}`), `POST /ioc` (admin upsert), `GET /healthz` (liveness), `GET /readyz` (DB+cache reachable), `GET /metrics` (Prometheus)
- Persistent store keyed `(type, value)` with `source`, `score`, `added_at`
- Cache layer, read-through, TTL, **invalidate on upsert**
- p99 < 200 ms including during 10× RPS spikes
- Containerized, k8s manifests, liveness/readiness/startup probes, **PDB minAvailable ≥ 2**, resource requests + limits
- HPA driven by **a signal that actually correlates with the workload** (CPU 70% is documented to fail)

**User-added constraints (Phase 1 questioning):**
1. Reproducible — assessor pulls repo, runs on Docker, minimal host deps
2. Bun runtime — use built-in TS, Bun.serve, bun:test, Bun.sql, Bun.redis where production-ready
3. Isolated example — careful calibration of values and load shapes

**Calibrated workload values (settled in Phase 1):**
- Pod resources: requests **300m CPU / 128Mi mem**, limits **1000m / 256Mi**
- Replicas: **min 2, max 10**
- HPA "bad" signal: **CPU 70% of request** (the exercise baseline)
- HPA "good" signal: **RPS = 100 / pod** (or in-flight = 20 / pod — RPS is the primary choice for explainability)
- Baseline load: **100 RPS**; burst: **1000 RPS** (10× per spec); burst hold **4 min**; drain **5 min**
- DB pool per pod: **10**; cache TTL **5 min**; seeded IOCs **10 000** (hot ~100 keys queried 90% of the time)

---

## Research Summary

Full notes in `.claude/plans/iocheck-research.md`. The findings that materially shape this plan:

- **Bun.sql + Bun.redis** are production-ready for this use case (read-heavy lookups, simple upserts, GET/SET cache). Caveats documented; not blockers. Fallback to `porsager/postgres` / `ioredis` is one import-swap if needed.
- **prom-client@^15.1.2** works on Bun, but **must not call `collectDefaultMetrics()`** — it crashes on `monitorEventLoopDelay`. Hand-pick metrics; expose `server.pendingRequests` as an in-flight gauge.
- **Bun.serve** has **no built-in SIGTERM** handler and an aggressive **10 s idleTimeout** that includes handler time. Must hand-wire the shutdown sequence (fail readyz → sleep → `server.stop()` → close pools) and raise idleTimeout for slow miss-path queries.
- **KEDA 2.19** via single-manifest install; `metricType: AverageValue` causes HPA to divide the metric by replica count internally — **PromQL must return cluster-total, not per-pod**. `cooldownPeriod` is N→0 only; N→1 stabilization lives under `advanced.horizontalPodAutoscalerConfig.behavior.scaleDown.stabilizationWindowSeconds`. `fallback.replicas` covers the "Prometheus down" failure mode.
- **kube-prometheus v0.17.0** (manifest, not chart) gives Prometheus + Grafana + Operator pre-wired. **Must patch the Prometheus CR with `enableRemoteWriteReceiver: true`** for k6 push to work — Prometheus 3.x silently 404s otherwise. Drop alertmanager + blackbox-exporter to fit a laptop RAM budget.
- **kind v0.31.0** with `kindest/node:v1.32.0`, 3 workers + 1 control-plane, `extraPortMappings` for NodePort access. `kind load docker-image iocheck:dev` after every rebuild. **No `:latest` tags** (pull-always footgun).
- **k6 v2.0.0** as an in-cluster Job — `ramping-arrival-rate` (open model, fixed RPS targets), **not** `ramping-vus`. Push metrics via `--out=experimental-prometheus-rw`.

---

## Approach

Single committed approach; no fork in the design. Alternatives belong in the writeup, not the implementation.

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

Files affected: `package.json`, `bun.lock`, `tsconfig.json`, `src/server.ts`, `src/db.ts`, `src/cache.ts`, `src/metrics.ts`, `src/lookup.ts`, `src/admin.ts`, `src/shutdown.ts`, `src/types.ts`

- [ ] `bun init` skeleton; `package.json` with scripts (`dev`, `start`, `test`, `test:integration`, `seed`, `build`); pin Bun version in `engines`
- [ ] `tsconfig.json` strict, `target: ESNext`, `moduleResolution: Bundler`
- [ ] `src/types.ts` — `IOCType = 'ip' | 'domain' | 'sha256'`, `IOC`, `LookupResult` (matching EXERCISE.md verdict shape)
- [ ] `src/db.ts` — `Bun.sql` client; `max: 10`, `idleTimeout: 30`, `connectionTimeout: 10`; `findIoc(type, value)`, `upsertIoc(ioc)` (with `ON CONFLICT (type, value) DO UPDATE`)
- [ ] `src/cache.ts` — `Bun.redis` client; key shape `ioc:{type}:{value}`; `get`/`setex` 300s TTL; `del` for invalidation; tombstone "unknown" cached with shorter TTL (60s) to absorb miss-path bursts
- [ ] `src/metrics.ts` — `prom-client` Registry (no defaults), counters/histograms: `http_requests_total{method,route,status}`, `http_request_duration_seconds`, `cache_lookups_total{result=hit|miss|unknown}`, `db_queries_total{op}`. Gauge `iocheck_inflight_requests` driven by `setInterval(() => g.set(server.pendingRequests), 1000)`
- [ ] `src/lookup.ts` — read-through: cache.get → if hit, return; else db.findIoc → cache.set → return. Return shape conforms to EXERCISE.md (`verdict`, `ioc?`)
- [ ] `src/admin.ts` — `X-Admin-Token` header check against `ADMIN_TOKEN` env var; upsert via db; **cache.del after upsert** (invalidation)
- [ ] `src/server.ts` — `Bun.serve` with `routes`: `POST /lookup`, `POST /ioc`, `GET /healthz`, `GET /readyz`, `GET /metrics`. Wrap each route with timing middleware. `idleTimeout: 30`. `readyz` checks Redis PING + Postgres `SELECT 1` (last-known-good with 1s TTL to avoid hammering)
- [ ] `src/shutdown.ts` — `process.on("SIGTERM"|"SIGINT", shutdown)`: set `isReady=false` → `sleep(5s)` → `server.stop()` → `sql.close()` → `redis.close()` → `process.exit(0)`

**Checks at end of Phase A:** `bun run start` against local `docker run` of Postgres + Redis; `curl /healthz`, `curl /readyz`, `curl POST /lookup`, `curl POST /ioc`, `curl /metrics`.

### Phase B — Tests

Files: `tests/setup.ts`, `tests/lookup.test.ts`, `tests/admin.test.ts`, `tests/metrics.test.ts`

- [ ] `tests/setup.ts` — preload; create ephemeral schema (`test_<uuid8>`), `SET search_path`, drop on exit; skip suite if `DATABASE_URL` / `REDIS_URL` unset (CI gate)
- [ ] `tests/lookup.test.ts` — known-malicious returns `{verdict:"malicious",ioc:{...}}`; unknown returns `{verdict:"unknown"}` with no `ioc` field; malformed body 400; unsupported `type` 400
- [ ] `tests/admin.test.ts` — happy upsert 201, returns same shape; missing/wrong token 401; upsert is idempotent (no duplicate row); upsert **invalidates** the cached entry
- [ ] `tests/metrics.test.ts` — `/metrics` returns 200 with `text/plain`; `http_requests_total` increments by 1 after one request; `cache_lookups_total{result="hit"}` increments after second identical lookup

**Checks:** `bun test` green.

### Phase C — Dockerfile + dev compose

Files: `Dockerfile`, `.dockerignore`, `docker-compose.yml`

- [ ] Multi-stage Dockerfile (`deps` → `runtime` on `oven/bun:1.3-slim`), `USER bun`, `EXPOSE 3000`, HEALTHCHECK against `/readyz`. ENTRYPOINT `["bun", "run", "src/server.ts"]`
- [ ] `.dockerignore` excludes `tests/`, `.claude/`, `logs/`, `manifests/`, `loadtest/`, `node_modules/`
- [ ] `docker-compose.yml` — three services (iocheck, postgres, redis) with healthchecks and `depends_on: condition: service_healthy`. Bind-mount `src/` for fast iteration. Exposes 3000 to host.

**Checks:** `docker compose up` → curl works; `docker build -t iocheck:dev .` produces an image under ~150 MB.

### Phase D — k8s manifests (cluster + service + data plane)

Files: `kind-config.yaml`, `manifests/namespace.yaml`, `manifests/iocheck/{deployment,service,pdb,configmap,secret,servicemonitor}.yaml`, `manifests/postgres/{statefulset,service,pvc,secret,init-configmap,seed-job}.yaml`, `manifests/redis/{deployment,service}.yaml`

- [ ] `kind-config.yaml` — 3 workers + 1 control-plane; `extraPortMappings` for 30080→8080 (iocheck), 30090→9090 (Prometheus), 30030→3000 (Grafana)
- [ ] `manifests/iocheck/deployment.yaml`:
  - Image `iocheck:dev`, `imagePullPolicy: IfNotPresent`
  - Resources: requests `cpu: 300m, memory: 128Mi`; limits `cpu: 1000m, memory: 256Mi`
  - Probes: `livenessProbe` on `/healthz` (period 10s); `readinessProbe` on `/readyz` (period 5s); `startupProbe` on `/readyz` (failureThreshold 30, period 1s)
  - `terminationGracePeriodSeconds: 30`
  - Pod anti-affinity (preferredDuringScheduling, `topologyKey: kubernetes.io/hostname`) so replicas spread across the 3 workers (**addresses challenge #2: "make sure pods share load"**)
  - Env: `DATABASE_URL`, `REDIS_URL`, `ADMIN_TOKEN` (from secret), `PORT=3000`, `NODE_ENV=production`
- [ ] `manifests/iocheck/pdb.yaml` — `minAvailable: 2` (matches min replicas)
- [ ] `manifests/iocheck/service.yaml` — ClusterIP + NodePort 30080 (one Service, both serve)
- [ ] `manifests/iocheck/servicemonitor.yaml` — `labels: {release: prometheus}` to match operator selector; scrape `/metrics` every 10s
- [ ] `manifests/postgres/statefulset.yaml` — `postgres:17-alpine`, 1 replica, PVC 2Gi (`storageClassName: standard` → kind's local-path), `pg_isready` readinessProbe, `max_connections=200` via init args
- [ ] `manifests/postgres/init-configmap.yaml` — `001-schema.sql`:
  ```sql
  CREATE TABLE IF NOT EXISTS iocs (
    type     TEXT NOT NULL,
    value    TEXT NOT NULL,
    source   TEXT NOT NULL,
    score    SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (type, value),
    CHECK (type IN ('ip','domain','sha256'))
  );
  ```
- [ ] `manifests/postgres/seed-job.yaml` — Job runs `iocheck:dev` image with `bun run scripts/seed.ts`; uses `ON CONFLICT (type, value) DO NOTHING`; idempotent; backoffLimit 3
- [ ] `scripts/seed.ts` — generates 10 000 synthetic IOCs: 100 "hot" with deterministic values + 9 900 "cold". Hot set must overlap with k6's request distribution for the cache-hit story
- [ ] `manifests/redis/deployment.yaml` — `redis:7.4-alpine`, args `--maxmemory 256mb --maxmemory-policy allkeys-lru --save ""` (ephemeral by design)

**Checks:** `kubectl apply -k manifests/` brings the stack up green; logs/probes clean; one curl through NodePort succeeds.

### Phase E — Observability (Prometheus + Grafana)

Files: `manifests/monitoring/kube-prometheus/` (vendored from upstream v0.17.0), `manifests/monitoring/patches/prometheus-cr.yaml`, `manifests/monitoring/grafana-dashboard-configmap.yaml`

- [ ] Vendor `kube-prometheus` v0.17.0 `manifests/setup/` and `manifests/` into `manifests/monitoring/kube-prometheus/`; pin commit SHA in a README inside the dir
- [ ] Strip alertmanager and blackbox-exporter manifests (RAM budget)
- [ ] Patch Prometheus CR: `enableRemoteWriteReceiver: true`, `retention: 6h`, requests `cpu: 100m, memory: 400Mi`, limits `memory: 1Gi`, `replicas: 1`
- [ ] Drop Grafana to 1 replica; default admin password via Secret; ConfigMap with one pre-built dashboard JSON: replica count, RPS, p95/p99, CPU utilization, in-flight, cache hit rate
- [ ] Label `iocheck` namespace so the operator's `serviceMonitorNamespaceSelector` matches

**Checks:** `kubectl port-forward svc/prometheus-k8s -n monitoring 9090:9090` → query `http_requests_total{service="iocheck"}` returns series; Grafana dashboard renders.

### Phase F — KEDA autoscaling (two scenarios, Kustomize overlays)

Files: `manifests/keda/keda-2.19.0.yaml` (vendored), `manifests/overlays/cpu-hpa/scaledobject.yaml`, `manifests/overlays/rps-hpa/scaledobject.yaml`, `manifests/overlays/{cpu-hpa,rps-hpa}/kustomization.yaml`

- [ ] Vendor KEDA `keda-2.19.0.yaml` (commit SHA pinned)
- [ ] **Overlay `cpu-hpa/`** — ScaledObject Scenario A (the "bad" one): `cpu` trigger type, `metricType: Utilization`, `value: "70"`, min 2 max 10, scaleDown stabilization 120s
- [ ] **Overlay `rps-hpa/`** — ScaledObject Scenario B (the "good" one): `prometheus` trigger, query `sum(rate(http_requests_total{service="iocheck"}[1m]))`, `metricType: AverageValue`, threshold `"100"` (target 100 RPS/pod), `activationThreshold: "5"`, scaleDown stabilization 120s, **`fallback: {failureThreshold: 3, replicas: 4, behavior: static}`** (covers "Prometheus down" question in the writeup)
- [ ] Inline comment in each ScaledObject explaining the AverageValue/HPA divide-by-replicas gotcha
- [ ] Kustomize base under `manifests/iocheck/`; overlays compose base + ScaledObject

**Checks:**
- Apply `cpu-hpa` overlay → `kubectl get hpa -n iocheck` shows HPA targeting CPU 70%
- Apply `rps-hpa` overlay → `kubectl get scaledobject` `READY=True`, `ACTIVE=False` at rest

### Phase G — Load test (k6 in-cluster)

Files: `loadtest/script.js`, `loadtest/job.yaml`, `loadtest/configmap.yaml`

- [ ] `loadtest/script.js` — `ramping-arrival-rate` executor: stages 60s→100, 4m→1000, 5m→0; `preAllocatedVUs: 200`, `maxVUs: 500`; thresholds `http_req_failed: ['rate<0.01']`, `http_req_duration: ['p(99)<200']`
- [ ] Request body: random pick from a list of 100 hot IOCs (90% of traffic) + 900 cold IOCs (10%, exercises miss path). List must be a subset of seeded values
- [ ] `loadtest/configmap.yaml` mounts `script.js`
- [ ] `loadtest/job.yaml` — `grafana/k6:2.0.0`, args include `--out=experimental-prometheus-rw`, `K6_PROMETHEUS_RW_SERVER_URL=http://prometheus-k8s.monitoring.svc:9090/api/v1/write`, `--tag testid=...`
- [ ] Run with `kubectl create -f loadtest/job.yaml --dry-run=client -o yaml | kubectl apply -f -` (re-creatable name) or generate unique name per run

**Checks:** Job runs, k6 stdout shows ramp, Prometheus has `k6_*` series, Grafana panel shows the curve.

### Phase H — Makefile + reproducibility

Files: `Makefile`, `README.md`

- [ ] `Makefile` targets:
  - `make help` — list targets with one-liners
  - `make tools-check` — verify `docker`, `kind`, `kubectl` present; print versions; **no auto-install** (assessor controls their env)
  - `make up` — `kind create cluster --config kind-config.yaml`; load `iocheck:dev`; apply KEDA, monitoring, namespace, postgres, redis, seed-job, iocheck (base); wait for rollouts; print access URLs
  - `make down` — `kind delete cluster --name iocheck`
  - `make build` — `docker build -t iocheck:dev .` + `kind load docker-image iocheck:dev`
  - `make rebuild` — `make build && kubectl rollout restart deployment/iocheck -n iocheck`
  - `make scenario-cpu` — `kubectl apply -k manifests/overlays/cpu-hpa/`; `kubectl delete -k manifests/overlays/rps-hpa/ --ignore-not-found`
  - `make scenario-rps` — inverse
  - `make load` — `kubectl create -f loadtest/job.yaml`
  - `make load-stop` — `kubectl delete job/k6-load -n iocheck --ignore-not-found`
  - `make watch` — `watch -n 1 'kubectl get pods,hpa,scaledobject -n iocheck && echo && kubectl top pods -n iocheck 2>/dev/null'`
  - `make grafana` — port-forward + open browser
  - `make logs` — `kubectl logs -l app=iocheck -n iocheck --tail=100 -f`
- [ ] `README.md`:
  - Prereqs (Docker ≥ 24, kind ≥ 0.31, kubectl ≥ 1.32; mention Bun is optional for host dev)
  - One-shot quickstart: `make up && make scenario-rps && make load`
  - Walkthrough script for the 30-min demo (six commands, expected outputs)
  - Troubleshooting table (kind RAM, image not loaded, KEDA not scaling)
  - Pointer to WRITEUP.md and `logs/` (AI transcripts)

**Checks:** `make down && make up` on a clean machine completes in < 6 min; all probes green; `make scenario-rps && make load` produces visible scale-up within 60s.

### Phase I — Writeup

Files: `WRITEUP.md`

- [ ] ~1–2 pages, markdown. Structure:
  1. **Architecture** — diagram + 1 paragraph
  2. **Challenge 1 — Why CPU-based HPA is wrong:** Grafana screenshot showing CPU < 60% while p99 > 1 s; explanation that I/O-bound cache-hit traffic does not move CPU enough to trigger 70%; bottleneck is event-loop + DB pool concurrency
  3. **Challenge 2 — Pod load sharing:** pod anti-affinity spreads replicas across kind workers; k6 runs in-cluster against ClusterIP so kube-proxy round-robins; show `kubectl logs` request counts per pod balanced within ±10%
  4. **Challenge 3 — Autoscaler that scales up and down:** KEDA Prometheus trigger on `sum(rate(http_requests_total))`, `metricType: AverageValue`, threshold 100 RPS/pod, `scaleDown.stabilizationWindowSeconds: 120`. Show 2 → 10 → 2 sequence
  5. **Challenge 4 — Reproducible test:** `make scenario-rps && make load`; Grafana panel timeline
  6. **What happens if the autoscaler's data source is unavailable:** KEDA `fallback.replicas: 4, behavior: static` pins to a sane mid-load count; PrometheusRule alerts when fallback engages
  7. **What I'd do differently with another week:** CloudNativePG for HA Postgres + PgBouncer; distroless compiled-binary image; in-flight-requests metric as primary signal (RPS is intuitive but in-flight is causally closer to saturation); OpenTelemetry tracing; signed images + admission policies; real auth on `/ioc` (mTLS or OIDC)
- [ ] Inline Grafana screenshots (saved to `WRITEUP_assets/`)

### Phase J — Demo dry-run + capture

- [ ] Full clean run: `make down && make up && make scenario-cpu && make load`; wait full cycle; capture Grafana screenshot of "CPU < 70%, replicas flat at 2, p99 wall" (Challenge 1 evidence)
- [ ] `make scenario-rps && make load` again; capture "2 → ~10, p99 < 200ms"; capture scale-down to 2
- [ ] Verify all four challenges visibly demonstrable
- [ ] Confirm `logs/` directory contains AI transcripts for the AI-chat-logs deliverable

---

## Edge cases & error handling

- **Prometheus down** → KEDA `fallback.replicas: 4, behavior: static` (covered in writeup)
- **Postgres pool exhaustion** at scale → Bun.sql `max: 10` × max 10 pods = 100 conns; raise Postgres `max_connections` to 200 in StatefulSet args for headroom
- **Redis down** → readyz fails (per EXERCISE.md spec). Service stops receiving traffic; cleanly recovers when Redis returns. Don't degrade to "DB-only mode" — that's a silent SLA breach
- **Bun idleTimeout** → raised to 30s so slow miss-path queries don't reset connections under burst
- **SIGTERM** → drain pattern (readyz=false → sleep 5s → server.stop → pool close → exit). `terminationGracePeriodSeconds: 30` covers it
- **kind RAM budget** → strip alertmanager + blackbox-exporter; Prometheus retention=6h, replicas=1
- **Image not loaded into kind** → explicit `iocheck:dev` tag, `imagePullPolicy: IfNotPresent`, `make build` always runs `kind load docker-image`
- **KEDA AverageValue / replica-divide gotcha** → PromQL returns cluster-total; inline comment in YAML
- **`/ioc` auth** → shared `X-Admin-Token`; 401 on missing/wrong; deliberately not exposing existence
- **Seed Job concurrency** → `ON CONFLICT (type, value) DO NOTHING`; idempotent across reruns
- **Cache poisoning on upsert** → `cache.del` immediately after successful DB upsert; eventual consistency window is the gap between DB commit and Redis DEL (one network hop)
- **Negative cache for unknown IOCs** → short TTL (60s) tombstone to absorb miss-path bursts on the same unknown value; expires fast enough not to mask a fresh upsert
- **`/lookup` body validation** → reject anything that isn't the documented shape with 400; missing `type` or unrecognized type returns 400 (don't 500 on bad input)

---

## Risks & open questions

1. **CPU calibration is empirical.** The per-cache-hit CPU estimate (~0.3 ms) drives the "CPU stays under 70%" claim. After Phase A, run a 60s flat-rate load test (single pod, no HPA) and **measure** CPU/RPS. If actual is much higher (e.g. cache-hit costs 1 ms instead of 0.3), the 300m request might let CPU sneak above 70% under burst — re-tune by raising the request to 400–500m. Locking this in is a Phase J task.
2. **kind RAM ceiling on a laptop.** Full stack worst case: 1 cp + 3 workers + Postgres + Redis + 10× iocheck + Prometheus + Grafana + KEDA + node-exporter + k6 Job. Estimate: 4–6 GB RAM. If too tight on the target machine, drop to 2 workers (still demonstrates anti-affinity).
3. **Bun.sql sharp edges.** None of the documented limitations (no LISTEN/NOTIFY, BIGINT-as-string, no name transform) bite this exercise. Risk: undocumented edge in a 1.3.x point release. Mitigation: keep `porsager/postgres` as a one-import swap.
4. **HPA scale-down stabilization tuning.** Default 300s is too slow for a 5-min demo. `120s` is the planned value but may need to drop to 60s if the drain segment runs out of room. Verify in Phase J.
5. **k6 push to Prometheus.** Requires `enableRemoteWriteReceiver: true` on the Prometheus CR. Silent failure if omitted. Verify in Phase E.
6. **In-cluster k6 hits ClusterIP; per-pod balance depends on kube-proxy iptables hashing.** Should be within ±10% but not perfect. If a worse split shows, switch the Service to `internalTrafficPolicy: Cluster` (default) and ensure k6 has many concurrent VUs (open-model executor does).
7. **30-min walkthrough timing.** Full cycle (cluster up → scenario A → scenario B → tear down) is tight. Pre-warm: run `make up` before the call; do scenarios live.

---

## Build Log

**2026-05-12** — implementation complete; Status: **COMPLETE**.

### What landed
- Phases A–J all done. Service, tests, Docker, k8s manifests, kube-prometheus,
  KEDA, k6 load test, Makefile, README, and WRITEUP. Bench artifacts are
  regenerated per run under `artifacts/<scenario>-<mode>-<ts>/`.
- Assessor surface = 4 Make targets (`up`, `bench-cpu`, `bench-rps`, `down`).
  Confirmed end-to-end on a fresh cluster: `make up` (~6 min), bench-cpu and
  bench-rps each run a 5-min profile and write an artifact directory.

### Deviations from the plan
- **kind extraPortMappings for Prometheus + Grafana removed** (Phase D). Docker
  binds the host port the moment the container starts even without a matching
  NodePort Service, shadowing `kubectl port-forward` binds. Kept the iocheck
  NodePort 30080→8080 mapping; Grafana + Prometheus access goes via Makefile
  port-forwards.
- **Prometheus `serviceMonitorNamespaceSelector` is `{}` not label-restricted.**
  An earlier draft restricted to `monitoring=true`, which excluded the
  `monitoring` namespace itself and silently broke kubelet/cadvisor scraping
  (and thus CPU-based HPA). Made the selector empty; the iocheck namespace's
  monitoring label remains as a marker, no longer load-bearing.
- **Prometheus NetworkPolicy patched** (`manifests/monitoring/prometheus-netpol-patch.yaml`).
  Upstream kube-prometheus allows only Grafana + adapter ingress. Extended to
  permit the `keda` namespace (autoscaler queries) and any namespace labelled
  `monitoring=true` (k6 remote-write push).
- **Prometheus CR patch via `kubectl patch --type=merge`, not `apply -f`**
  (Phase E). `apply -f` clobbers `podMetadata.labels` because the
  last-applied-config replaces the entire spec; the operator then can't
  populate the Service selector and the Service has zero endpoints.
- **prometheus-operator rollout restart in `.stack`** (Phase D). The operator
  caches the namespace list; without a forced re-sync after iocheck namespace
  creation, the iocheck ServiceMonitor never produces a scrape job.
- **Seed Job env-var ordering** (Phase D). `$(PGPASSWORD)` substitution in
  `DATABASE_URL` requires PGPASSWORD to be declared *before* DATABASE_URL in
  the env list — k8s only substitutes from prior entries.
- **Makefile inline `#` comments removed inside the bench heredoc** (Phase H).
  A `# comment \` after a chained shell command swallowed the rest of the
  bench cleanup section (capture script SIGTERM, summary banner) because
  make joins recipe lines into one shell string before the shell sees them.
- **CPU per-request cost was overestimated** (Risk #1 in original plan).
  Measured ~0.12 ms/hit, not 0.3 ms. Result: at 478 RPS/pod, peak CPU is
  20% of request — far below the 70% HPA threshold. The "wrong signal"
  narrative still holds (CPU never moves) but the "p99 walls" narrative
  doesn't materialise at this calibration; p99 stays < 20 ms in both
  scenarios. WRITEUP reframes accordingly.

### Reference bench numbers (representative run, hot-mix workload)
- **bench-cpu**: peak RPS 956.2, peak CPU 20.2%, replicas held at 2, peak p99
  5 ms. HPA never fired (CPU < 70%).
- **bench-rps**: peak RPS 956.7, replicas climbed 2 → 9 → 3 within the window,
  peak p99 16 ms. KEDA reading `sum(rate(http_requests_total{service="iocheck"}[1m]))`,
  threshold 100 RPS/pod, fallback.replicas=4.

## Summary

Completed: 2026-05-12

Files created/modified: ~40 — `src/*.ts`, `tests/*.test.ts`, `scripts/*`,
`manifests/{namespace,iocheck/*,postgres/*,redis/*,monitoring/*,overlays/*}`,
`loadtest/{script.js,job.yaml,configmap.yaml}`, `Dockerfile`,
`docker-compose.yml`, `kind-config.yaml`, `Makefile`, `README.md`, `WRITEUP.md`,
`dashboards/iocheck.json`. Bench artifacts are generated per run under
`artifacts/<scenario>-<mode>-<ts>/` and are not committed.

Key decisions worth recalling:
- Bun.serve + Bun.sql + Bun.redis (no external drivers).
- KEDA + Prometheus over prometheus-adapter for the autoscaler.
- kube-prometheus v0.17.0 vendored at make-up time (git clone into `.bin/`).
- Bench captures via `scripts/capture.ts`: replica trajectory CSV, PromQL
  snapshots, summary.md, HPA describe — all written on capture's SIGTERM
  handler so partial bench data is recoverable.

Deviations from plan: see Build Log above. None of them changed the
end-to-end deliverable shape, only intermediate fixes.

