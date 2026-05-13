# iocheck Research Notes

Research compiled from official documentation (bun.com/bun.sh, keda.sh, kind.sigs.k8s.io, prometheus.io, grafana.com/docs/k6, prometheus-operator.dev, hub.docker.com) and supporting sources, current as of May 2026. Cross-verifies vendor docs against GitHub release pages where possible.

Scope: TypeScript threat-intel lookup service on Bun, deployed to kind with KEDA + Prometheus autoscaling, k6 load tested, Postgres + Redis backends.

---

## 1. Bun runtime (Bun 1.3.x line; latest 1.3 series shipped Oct 2025, point releases through 2026)

### 1.1 `Bun.serve` HTTP API

Recommended approach: use the `routes` object (added Bun 1.2.3, default in 1.3) instead of the legacy `fetch`-only form. Falls through to a `fetch` handler for unmatched routes.

```ts
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/healthz": new Response("ok"),
    "/readyz": () => (isReady ? new Response("ok") : new Response("draining", { status: 503 })),
    "/metrics": async () => new Response(await registry.metrics(), { headers: { "Content-Type": registry.contentType } }),
    "/lookup/:ioc": (req) => handleLookup(req.params.ioc),
  },
  fetch: () => new Response("not found", { status: 404 }),
  error: (err) => { console.error(err); return new Response("internal error", { status: 500 }); },
});
```

Key facts:
- `server.pendingRequests` is a built-in counter — useful as a Prometheus gauge for in-flight requests without instrumentation.
- `server.stop()` (no arg) waits for in-flight requests; `server.stop(true)` force-closes. Returns a Promise.
- `idleTimeout` defaults to **10 seconds** — that includes time spent in your handler before the first byte. For slow Postgres queries under load this can reset connections. Raise it for the service (e.g. `idleTimeout: 30`) or use `server.timeout(req, 0)` per-request for streams.
- `server.reload({ routes })` swaps handlers without dropping connections — handy for hot reload but irrelevant in K8s where we kill the pod.
- `server.requestIP(req)` for client IP; null behind a Service unless `X-Forwarded-For` is set externally.

Graceful shutdown for K8s (Bun does not register SIGTERM by default):

```ts
let isReady = true;
const server = Bun.serve({ /* ... */ });

const shutdown = async () => {
  isReady = false;                  // readyz starts failing
  await new Promise(r => setTimeout(r, 5000)); // let kube-proxy unregister
  await server.stop();              // drains in-flight
  await sql.close({ timeout: 10 }); // drain pool
  redis.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

Gotcha: `terminationGracePeriodSeconds` in the Deployment must exceed the sleep + drain timeout (default 30s is fine for the 5s+10s pattern above).

### 1.2 `Bun.sql` for Postgres — production status

Verdict: production-ready for the iocheck use case (read-heavy IOC lookups, simple writes for a sightings table). Bun 1.3 promoted Bun.sql to a unified API across Postgres/MySQL/SQLite. Anthropic uses it in Claude Code. Caveats below.

```ts
import { sql, SQL } from "bun";

// Default client reads DATABASE_URL / POSTGRES_URL automatically.
const db = new SQL({
  url: process.env.DATABASE_URL,
  max: 20,                  // pool size; default 10
  idleTimeout: 30,
  connectionTimeout: 10,
  prepare: true,            // default; uses extended protocol + named prepared statements
});

const rows = await db`SELECT * FROM iocs WHERE value = ${value} LIMIT 1`;

await db.begin(async tx => {
  await tx`INSERT INTO sightings ${tx({ ioc_id, source, seen_at: new Date() })}`;
  await tx`UPDATE iocs SET last_seen = NOW() WHERE id = ${ioc_id}`;
});
```

Features that matter for us:
- Tagged template literals with parameter substitution (SQL-injection safe).
- Connection pooling built in (`max`, `idleTimeout`, `maxLifetime`).
- Named prepared statements by default.
- Transactions via `db.begin(async tx => ...)`, savepoints via `tx.savepoint`.
- Bulk insert helper: `await db\`INSERT INTO iocs ${db(records)}\`` expands an array of objects.
- `db`.simple()` for multi-statement migration scripts (no params allowed).
- `db.file("migration.sql", [arg])` for loading SQL from disk.
- Errors are typed: `SQL.PostgresError` exposes PG error codes; check `error.code === "23505"` for unique violation.

Gotchas / "don't do this":
- **BigInt:** BIGINT columns return as strings by default unless you set `bigint: true` on the client. Don't compare with `===` to numbers.
- **No `COPY`, `LISTEN`, `NOTIFY` yet** (per official roadmap). Irrelevant for iocheck.
- **No snake_case → camelCase transform yet** — pick a column-naming convention up front. Keep snake_case in DB and project the keys you need.
- **Portability:** code using `import { sql } from "bun"` won't run under Node. If you want to keep the door open for Node, `porsager/postgres` is API-compatible (Bun.sql was inspired by it) — see fallback below.

Fallback if Bun.sql bites you: `porsager/postgres` v3.4.9+ explicitly supports Bun, same tagged-template API, broader feature set (LISTEN/NOTIFY, cursors). Install with `bun add postgres`; switch the import. Same query syntax.

### 1.3 Bun's Redis client (`Bun.redis` / `RedisClient`)

Verdict: production-ready for our needs (GET/SET/EXISTS/EXPIRE caching of recent lookups). Bun's benchmark claim is ~7.9× ioredis; even if marketing-inflated, latency is sub-ms in practice. Supports Redis 7.2+.

```ts
import { redis, RedisClient } from "bun";

// Default client uses REDIS_URL / VALKEY_URL; defaults to redis://localhost:6379
const cache = new RedisClient(process.env.REDIS_URL, {
  connectionTimeout: 5000,
  idleTimeout: 0,
  autoReconnect: true,
  maxRetries: 10,
  enableOfflineQueue: true,    // queue commands while reconnecting
  enableAutoPipelining: true,  // pipelines concurrent calls
});

// String, hash, set ops; SETEX via expire
await cache.set(`ioc:${value}`, JSON.stringify(record));
await cache.expire(`ioc:${value}`, 300);

// Auto-pipelined when concurrent
const [a, b] = await Promise.all([cache.get("ioc:1.2.3.4"), cache.get("ioc:bad.example")]);

// Anything not wrapped:
await cache.send("SETEX", [`ioc:${value}`, "300", payload]);
```

Gotchas:
- **Transactions (MULTI/EXEC):** must be done via raw `send()` — Bun's docs explicitly call this out as a known limitation. Use `WATCH` if you need optimistic locking, otherwise prefer Lua via `EVAL` through `send()`.
- **No Sentinel / Cluster support yet.** Single Redis is fine for the demo, but mention this in the exercise writeup as a known limitation.
- **Pub/Sub is marked experimental** as of 1.2.23. A subscribed client cannot publish — use `.duplicate()`. Not relevant to iocheck unless you add live-feed subscriptions.
- **Booleans:** `EXISTS` and `SISMEMBER` return JS booleans, not 1/0. Matches Bun docs convention, but unusual if you're coming from ioredis.

Alternative if you need MULTI/cluster: `ioredis` works under Bun (most of Bun's compat issues affect prom-client, not ioredis).

### 1.4 `bun:test` for unit + integration

Jest-compatible API (`describe`, `test`, `expect`, `beforeAll`, `afterEach`, `mock`). Recursively picks up `*.test.ts`, `*_test.ts`, `*.spec.ts`. Fast — Bun docs claim it runs 266 React SSR tests faster than Jest prints its version banner; whatever the real ratio, it's faster than Jest by a wide margin on our scale.

```ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { sql } from "bun";

describe("ioc repository", () => {
  beforeAll(async () => {
    await sql`CREATE TEMP TABLE iocs (...)`;
  });
  afterAll(async () => { await sql.close(); });

  test("returns null for unknown value", async () => {
    expect(await findIoc("nope")).toBeNull();
  });
});
```

CLI flags that matter:
- `--coverage --coverage-reporter=lcov --coverage-dir=coverage` (no nyc needed).
- `--reporter=junit --reporter-outfile=bun.xml` for CI integrations.
- `--concurrent` runs async tests in parallel within a file.
- `--retry 3` for flaky integration tests against real Postgres.
- `CLAUDECODE=1 bun test` enables quiet output in AI agent environments.

Integration testing pattern: testcontainers-node works under Bun (it's pure JS shelling out to Docker). For a leaner approach, use **kind already running** + a `bun:test` `--preload` hook that resets schema before each suite. For Postgres specifically, a "throwaway schema per test file" pattern is faster than full container teardown:

```ts
// tests/setup.ts (passed via --preload)
import { sql } from "bun";
import { beforeAll, afterAll } from "bun:test";
const schema = `test_${crypto.randomUUID().slice(0,8)}`;
beforeAll(async () => { await sql.unsafe(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`); });
afterAll(async () => { await sql.unsafe(`DROP SCHEMA ${schema} CASCADE;`); });
```

No native testcontainers integration; use the npm `testcontainers` package if you want it.

### 1.5 Prometheus metrics in Bun

**`prom-client` (siimon/prom-client) — works, with one caveat.** v15.1.2+ added explicit Bun support by catching `NotImplemented` errors. Counters, gauges, histograms, summaries, and the registry all function. The pitfall: `collectDefaultMetrics()` calls `perf_hooks.monitorEventLoopDelay()`, which is undefined in Bun (issue #18300). Workaround: disable event-loop metrics.

```ts
import client from "prom-client";

const registry = new client.Registry();
// Don't pass eventLoopMonitoringPrecision; the call into monitorEventLoopDelay will throw.
// Skip default metrics entirely on Bun, or hand-pick:
registry.setDefaultLabels({ service: "iocheck" });

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});
export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});
```

Expose via Bun.serve route at `/metrics` returning `registry.metrics()` with `registry.contentType`.

No production-grade Bun-native Prometheus client exists yet — `prom-client` is the consensus choice.

Don't do this: avoid `client.collectDefaultMetrics()` without guarding it. It either crashes or silently no-ops depending on which Bun version you're on.

### 1.6 `bun build` for Docker

Two reasonable approaches:

**Option A (recommended for this exercise): non-compiled, multi-stage `oven/bun:1` image.** Smaller maintenance burden, hot-fix friendly. Bun's startup is already fast.

```dockerfile
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./
USER bun
EXPOSE 3000
ENTRYPOINT ["bun", "run", "src/server.ts"]
```

Image variants: `oven/bun:1.3` (Debian, ~140MB), `oven/bun:1.3-slim` (~80–90MB), `oven/bun:1.3-alpine` (Alpine, musl), `oven/bun:1.3-distroless` (smallest, no shell). Distroless is good for prod but harder to debug; slim is the practical sweet spot for the demo.

**Option B: `bun build --compile` single-file binary.** Bundles runtime + bytecode + app into one ELF. Adds bytecode caching for faster cold starts.

```dockerfile
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build --compile --minify --sourcemap --bytecode \
    --target=bun-linux-x64-modern \
    ./src/server.ts --outfile /out/iocheck

FROM gcr.io/distroless/base-debian12
COPY --from=build /out/iocheck /iocheck
EXPOSE 3000
ENTRYPOINT ["/iocheck"]
```

Notes for `--compile`:
- `--target=bun-linux-x64-modern` for any host newer than 2013 — faster. Use `bun-linux-x64-baseline` if image runs on older nodes. For ARM use `bun-linux-arm64`. `bun-linux-x64-musl` for Alpine-based final stage.
- `--bytecode` moves parse time from runtime to build time. Documented 2× faster startup for tsc-sized inputs.
- Resulting binary is ~80–100MB on its own (Bun runtime is large) — Alpine/distroless final stage matters less when the binary dominates.
- `bunfig.toml` and `.env` are auto-loaded at runtime by compiled binaries unless you pass `--no-compile-autoload-dotenv` / `--no-compile-autoload-bunfig`. For deterministic K8s runs, disable both and rely on env vars from the Pod spec.

Recommendation: use Option A for the take-home (faster iteration, easier debugging in the demo). Mention Option B as a production hardening step.

---

## 2. KEDA (v2.19.0; latest as of May 2026)

### 2.1 Installation

Two paths, both supported:

```bash
# Manifest (preferred for reproducibility — single file, version pinned)
kubectl apply --server-side -f \
  https://github.com/kedacore/keda/releases/download/v2.19.0/keda-2.19.0.yaml

# Helm
helm repo add kedacore https://kedacore.github.io/charts
helm install keda kedacore/keda --namespace keda --create-namespace --version 2.19.0
```

Use the manifest install for the exercise — single command, single artifact, easy to commit to the repo. The KEDA docs explicitly say "YAML manifests offer the most control… perfect for environments requiring strict configurations." Helm is better when you're parameterizing across environments.

After install, KEDA runs in `keda` namespace with two deployments (`keda-operator`, `keda-operator-metrics-apiserver`). The metrics-apiserver registers as a Kubernetes external metrics adapter.

### 2.2 `ScaledObject` for HTTP services on a Prometheus metric

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: iocheck
  namespace: iocheck
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: iocheck
  pollingInterval: 15      # KEDA polls Prometheus every 15s
  cooldownPeriod: 60       # Only used for 1->0; HPA controls 1->N stabilization
  minReplicaCount: 1
  maxReplicaCount: 20
  fallback:
    failureThreshold: 3    # After 3 polling failures, apply fallback.replicas
    replicas: 4
    behavior: static
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0      # Aggressive scale-up
          policies:
            - type: Percent
              value: 100
              periodSeconds: 15
            - type: Pods
              value: 4
              periodSeconds: 15
            # HPA picks the larger of the policies by default
        scaleDown:
          stabilizationWindowSeconds: 120    # Wait 2 min before scaling down
          policies:
            - type: Percent
              value: 25
              periodSeconds: 60
  triggers:
    - type: prometheus
      metricType: AverageValue
      metadata:
        serverAddress: http://prometheus-server.monitoring.svc:9090
        query: sum(rate(http_requests_total{service="iocheck"}[1m]))
        threshold: "50"               # target ~50 RPS per pod
        activationThreshold: "5"      # only scale up off 0 when total RPS > 5
```

### 2.3 PromQL pattern for RPS-per-pod (a known footgun)

KEDA + HPA computes `desiredReplicas = ceil(currentReplicas * currentMetricValue / threshold)`. With `metricType: AverageValue`, KEDA reports the metric value to HPA which then divides internally by the replica count. **You should provide the cluster-total RPS, not per-pod**; HPA does the division. So:

- Right: `query: sum(rate(http_requests_total{service="iocheck"}[1m]))` with `metricType: AverageValue` and `threshold: "50"` → "target 50 RPS per pod"
- Wrong: dividing in PromQL with `/ on() kube_deployment_status_replicas_ready{...}` and using `AverageValue` → double-divides.

If you must pre-divide in PromQL, switch `metricType: Value`. The KEDA discussion #3035 documents this as the #1 source of confusion.

For in-flight requests per pod (simpler, more responsive than RPS for a tail-latency-sensitive API):

```yaml
query: sum(bun_pending_requests{service="iocheck"})
threshold: "20"           # target 20 in-flight per pod
metricType: AverageValue
```

Expose `bun_pending_requests` from `/metrics` by sampling `server.pendingRequests` in a setInterval gauge.

### 2.4 How KEDA interacts with HPA

KEDA generates an HPA object on your behalf when the ScaledObject's `IsActive` returns true (i.e. activationThreshold exceeded). That HPA targets KEDA's external metrics adapter. The lifecycle:

- 0 replicas → KEDA polls Prometheus directly. When the activation threshold is exceeded, KEDA scales to `minReplicaCount` (typically 1), creates the HPA.
- 1..N replicas → HPA polls KEDA's metrics adapter every 15s (the `--horizontal-pod-autoscaler-sync-period` of kube-controller-manager). HPA computes desiredReplicas using the standard formula.
- All triggers inactive → after `cooldownPeriod` seconds, KEDA deletes the HPA and scales to 0.

Important: **`cooldownPeriod` only applies to scaling to zero.** Scale-down from N→1 is governed by HPA's `behavior.scaleDown.stabilizationWindowSeconds` (set in `advanced.horizontalPodAutoscalerConfig.behavior`). Default HPA stabilization is 300s downscale, 0s upscale. Configure explicitly.

### 2.5 Failure mode: Prometheus unavailable

KEDA 2.19's `fallback` field is the right answer. Set `fallback.failureThreshold` (consecutive scaler failures before fallback kicks in) and `fallback.replicas`. With `behavior: static`, KEDA pins the HPA target to that replica count until Prometheus recovers.

```yaml
fallback:
  failureThreshold: 3
  replicas: 4
  behavior: static
```

Without fallback, the HPA will report `ScalingActive=False` with a `FailedGetExternalMetric` reason and stop scaling — keeping the current replica count but unable to react to load.

Other failure modes worth mentioning in the demo:
- If KEDA's metrics-apiserver is OOMKilled, every dependent HPA freezes. Set sane resource requests/limits.
- `pollingInterval` too low (< 10s) on a busy Prometheus = noisy queries, throttling, and KEDA log spam.

---

## 3. Prometheus + Grafana on kind

### 3.1 Simplest install for the demo

Use **kube-prometheus** (the project, not the Helm chart) — manifest-based, includes Prometheus Operator + Prometheus + Alertmanager + Grafana + node-exporter + kube-state-metrics + Prometheus Adapter, pre-wired with ServiceMonitors and dashboards.

```bash
# v0.17.0 is current as of 2026-03 per github.com/prometheus-operator/kube-prometheus
git clone --depth=1 --branch v0.17.0 https://github.com/prometheus-operator/kube-prometheus
cd kube-prometheus
kubectl apply --server-side -f manifests/setup
kubectl wait --for condition=Established --all CustomResourceDefinition --namespace=monitoring
kubectl apply -f manifests/
```

Alternative: `kube-prometheus-stack` Helm chart is more parameterizable but adds Helm to the toolchain. For the take-home, the kube-prometheus manifests are easier to commit and tweak.

Bare `prometheus-operator` alone is too low-level (you'd need to write your own Prometheus CR, Grafana, etc.) — skip.

Why this matters for autoscaling: kube-prometheus installs `prometheus-adapter`, which exposes Prometheus metrics as Kubernetes custom metrics. KEDA's Prometheus scaler doesn't need this (it queries Prometheus directly), but the adapter is useful if you want vanilla HPA on a custom metric as a comparison demo.

Important flag to enable on Prometheus: **`--web.enable-remote-write-receiver`** if you want k6 to push test metrics directly to Prometheus (see §5). For kube-prometheus, patch the Prometheus CR:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata: { name: k8s, namespace: monitoring }
spec:
  enableRemoteWriteReceiver: true   # field added in operator v0.74+
```

Or use the older `--enable-feature=remote-write-receiver` form on Prometheus < 3.0. As of Prometheus 3.x the receiver flag is documented but in practice you still need to set it explicitly — silent 404s otherwise.

### 3.2 ServiceMonitor vs annotation-based scraping

With the Prometheus Operator installed (which kube-prometheus brings), use **`ServiceMonitor`** CRs. Cleaner, declarative, and scoped via label selectors.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: iocheck
  namespace: iocheck
  labels: { release: prometheus }    # must match Prometheus CR's serviceMonitorSelector
spec:
  selector: { matchLabels: { app: iocheck } }
  endpoints:
    - port: http
      path: /metrics
      interval: 10s
```

Check the Prometheus CR's `serviceMonitorSelector` (kube-prometheus uses `{}` by default, scoped to namespaces via `serviceMonitorNamespaceSelector`). You may need to label the `iocheck` namespace to make it visible.

Annotation-based scraping (`prometheus.io/scrape: "true"`) only works if you configure Prometheus to read those annotations — kube-prometheus does not. Don't go down that path; use ServiceMonitor.

### 3.3 Resource sizing for kind

kube-prometheus defaults assume a real cluster. On kind, the default Prometheus retention and memory will bog down a laptop. Patch:

```yaml
# manifests/prometheus-prometheus.yaml
spec:
  retention: 6h
  resources:
    requests: { memory: 400Mi, cpu: 100m }
    limits: { memory: 1Gi }
  replicas: 1
```

Similarly drop Grafana to a single replica, and consider removing alertmanager + blackbox-exporter for the demo if RAM is tight.

---

## 4. kind (v0.31.0)

### 4.1 Multi-node config (3 workers + 1 control plane, with port mapping)

```yaml
# kind-config.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: iocheck
nodes:
  - role: control-plane
    extraPortMappings:
      - { containerPort: 30080, hostPort: 8080, protocol: TCP }  # iocheck NodePort
      - { containerPort: 30090, hostPort: 9090, protocol: TCP }  # Prometheus NodePort
      - { containerPort: 30030, hostPort: 3000, protocol: TCP }  # Grafana NodePort
  - role: worker
  - role: worker
  - role: worker
networking:
  apiServerAddress: "127.0.0.1"
  kubeProxyMode: iptables
```

```bash
kind create cluster --config kind-config.yaml --image kindest/node:v1.32.0
```

Pin `kindest/node` to a specific Kubernetes version — kind 0.31.0 supports up through v1.34. Kubernetes 1.32 is stable and matches KEDA 2.19's well-tested floor.

### 4.2 Loading locally built images

```bash
docker build -t iocheck:dev .
kind load docker-image iocheck:dev --name iocheck
```

Pitfalls:
- **Avoid `:latest` tags** — kind warns that `:latest` triggers `imagePullPolicy: Always` which then tries to pull from a registry. Use immutable tags like `iocheck:dev` or `iocheck:$(git rev-parse --short HEAD)`.
- Set `imagePullPolicy: IfNotPresent` (or `Never`) in your Deployment to be explicit.
- Loading is per-node — if you add a worker after loading, you'll need to reload. `kind load` handles this for the current node set automatically.

### 4.3 Exposing services for load testing

Two paths:

1. **NodePort + extraPortMappings (what we use above).** Simplest. Map node port 30080 → host 8080, expose the iocheck Service as `type: NodePort, nodePort: 30080`. k6 from the host targets `http://localhost:8080`.

2. **Ingress (nginx).** Slightly more realistic. Install ingress-nginx with the kind-specific patch (`https://kind.sigs.k8s.io/examples/ingress/deploy-ingress-nginx.yaml`), label control-plane with `ingress-ready=true`, and use the same extraPortMappings for ports 80/443. Worth it if you want path-based routing or to demo realistic TLS termination.

For a 1000 RPS demo, NodePort is fine. The bottleneck will be the iocheck pods, not the ingress.

For **in-cluster** load testing (k6 Job → ClusterIP Service), no port mapping is needed — k6 hits `http://iocheck.iocheck.svc:80` directly. This is the recommended path for the autoscaling demo because it removes the host-network hop variance.

---

## 5. k6 (v2.0.0 — grafana/k6 latest tag, May 2026)

### 5.1 Running as a Kubernetes Job

For a single-pod 1000 RPS test the `grafana/k6` image as a Job is the simplest path. Skip the k6-operator (it's designed for multi-pod distributed runs).

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: k6-script, namespace: iocheck }
data:
  script.js: |
    import http from 'k6/http';
    import { check } from 'k6';

    export const options = {
      discardResponseBodies: true,
      scenarios: {
        load: {
          executor: 'ramping-arrival-rate',
          startRate: 1,
          timeUnit: '1s',
          preAllocatedVUs: 200,
          maxVUs: 500,
          stages: [
            { duration: '60s', target: 100 },     // ramp to 100 RPS
            { duration: '4m', target: 1000 },     // burst to 1000 RPS, hold
            { duration: '5m', target: 0 },        // drain
          ],
        },
      },
      thresholds: {
        http_req_failed: ['rate<0.01'],
        http_req_duration: ['p(95)<200'],
      },
    };

    const iocs = ['1.2.3.4', 'evil.example', 'deadbeef...', /* ... */];
    export default function () {
      const ioc = iocs[Math.floor(Math.random() * iocs.length)];
      const res = http.get(`http://iocheck.iocheck.svc:80/lookup/${ioc}`);
      check(res, { 'status 200': r => r.status === 200 });
    }
---
apiVersion: batch/v1
kind: Job
metadata: { name: k6-load, namespace: iocheck }
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: k6
          image: grafana/k6:2.0.0
          args:
            - run
            - --out=experimental-prometheus-rw
            - --tag=testid=iocheck-$(date +%s)
            - /scripts/script.js
          env:
            - name: K6_PROMETHEUS_RW_SERVER_URL
              value: http://prometheus-k8s.monitoring.svc:9090/api/v1/write
          volumeMounts:
            - { name: script, mountPath: /scripts }
      volumes:
        - name: script
          configMap: { name: k6-script }
```

### 5.2 Why `ramping-arrival-rate` (not `ramping-vus`)

`ramping-vus` ramps virtual users — actual throughput is whatever those VUs can squeeze out. `ramping-arrival-rate` is open-model: it targets a fixed iteration rate per `timeUnit` and adjusts VUs to hit it. For "60s to 100 RPS, hold 1000 RPS for 4 min, drain over 5 min" you want `ramping-arrival-rate`.

Required: `preAllocatedVUs` (initial VU pool) and `maxVUs` (cap). Rule of thumb: `maxVUs ≥ targetRate × p95_latency_seconds × safety_factor (~3)`. For 1000 RPS and 50ms p95: 1000 × 0.05 × 3 ≈ 150 VUs minimum; the script sets 500 for headroom.

### 5.3 Outputs

- **stdout summary** is automatic. JSON summary at end-of-test: `--summary-export=/tmp/summary.json`.
- **Streaming to Prometheus:** `--out=experimental-prometheus-rw` with `K6_PROMETHEUS_RW_SERVER_URL`. Requires Prometheus running with `--web.enable-remote-write-receiver` (or the `enableRemoteWriteReceiver: true` field on the Prometheus CR). Metrics are prefixed `k6_` (e.g. `k6_http_reqs_total`, `k6_http_req_duration`). Add `testid` tag to segment runs.
- **JSON file output:** `--out=json=/tmp/results.json` for offline analysis.
- **k6 Cloud:** ignore for this exercise (account + auth).

For the Grafana panels showing the load test, point Grafana at the same Prometheus and use `k6_http_reqs_total` / `k6_http_req_duration_p_95` series.

### 5.4 In-cluster vs external load

Run k6 as a Job inside the cluster against `ClusterIP`. Reasons:
- Avoids host-to-container network capping the test.
- Lets you measure pure service latency, not the kind port-forward / NodePort overhead.
- Simpler: no `kubectl port-forward` to maintain during the test.

### 5.5 Gotcha

Prometheus's default scrape interval (15s) under-samples a 60s ramp. Either drop the scrape interval to 5s for the `iocheck` ServiceMonitor or use k6's remote-write output (~1s granularity) for the load-test view in Grafana.

---

## 6. Postgres + Redis in kind

### 6.1 Postgres — minimal single-replica manifest

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: postgres-init, namespace: iocheck }
data:
  001-schema.sql: |
    CREATE TABLE IF NOT EXISTS iocs (
      id          BIGSERIAL PRIMARY KEY,
      value       TEXT NOT NULL UNIQUE,
      type        TEXT NOT NULL,    -- ip, domain, hash, etc.
      threat      TEXT NOT NULL,
      first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS iocs_value_idx ON iocs (value);
---
apiVersion: v1
kind: Secret
metadata: { name: postgres-secret, namespace: iocheck }
type: Opaque
stringData: { POSTGRES_PASSWORD: iocheckdev }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: postgres-data, namespace: iocheck }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 2Gi } }
  storageClassName: standard          # kind ships with a "standard" rancher local-path-provisioner
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: postgres, namespace: iocheck }
spec:
  serviceName: postgres
  replicas: 1
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
        - name: postgres
          image: postgres:17-alpine
          env:
            - name: POSTGRES_DB
              value: iocheck
            - name: POSTGRES_USER
              value: iocheck
            - name: POSTGRES_PASSWORD
              valueFrom: { secretKeyRef: { name: postgres-secret, key: POSTGRES_PASSWORD } }
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports: [{ containerPort: 5432, name: pg }]
          readinessProbe:
            exec: { command: [pg_isready, -U, iocheck, -d, iocheck] }
            periodSeconds: 5
          resources:
            requests: { cpu: 200m, memory: 512Mi }
            limits: { memory: 1Gi }
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql/data }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: postgres-data }
---
apiVersion: v1
kind: Service
metadata: { name: postgres, namespace: iocheck }
spec:
  selector: { app: postgres }
  ports: [{ port: 5432, targetPort: 5432 }]
  clusterIP: None      # headless for StatefulSet identity
```

Tradeoff callouts (mention these in the writeup):
- Single replica = no HA. For a production system, use CloudNativePG operator or Zalando postgres-operator (handles streaming replication, PITR backups, failover).
- `storageClassName: standard` resolves to kind's default `local-path` provisioner — node-local, lost if you delete the kind cluster.
- No external connection pooler. Bun.sql's pool is in-process per pod. Under heavy autoscaling, pod count × pool size can exhaust Postgres connections. With `max: 20` per pod and `max_connections=100` (Postgres default), you cap at 5 pods before contention. Either lower `max` to 10 per pod or raise Postgres `max_connections` to 200.

### 6.2 Init job for schema + seed 10k IOCs

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: postgres-seed, namespace: iocheck }
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      initContainers:
        - name: wait-for-pg
          image: postgres:17-alpine
          command: ["sh", "-c", "until pg_isready -h postgres -U iocheck; do sleep 1; done"]
      containers:
        - name: seed
          image: oven/bun:1.3-slim
          env:
            - name: DATABASE_URL
              value: postgres://iocheck:$(POSTGRES_PASSWORD)@postgres:5432/iocheck
            - name: POSTGRES_PASSWORD
              valueFrom: { secretKeyRef: { name: postgres-secret, key: POSTGRES_PASSWORD } }
          command: ["bun", "/scripts/seed.ts"]
          volumeMounts:
            - { name: scripts, mountPath: /scripts }
      volumes:
        - name: scripts
          configMap: { name: postgres-init }
```

Seed script (mount as ConfigMap or COPY into a one-off image):

```ts
// seed.ts — generates 10k synthetic IOCs in a single bulk insert
import { sql } from "bun";
const TYPES = ["ip", "domain", "sha256"];
const records = Array.from({ length: 10000 }, (_, i) => ({
  value: `${TYPES[i % 3]}-${crypto.randomUUID()}`,
  type: TYPES[i % 3],
  threat: i % 5 === 0 ? "malware" : "phishing",
}));
// Bun.sql expands the array helper into a single multi-row INSERT.
await sql`INSERT INTO iocs ${sql(records)} ON CONFLICT (value) DO NOTHING`;
console.log(`seeded ${records.length}`);
await sql.close();
```

Use `bun:test` or a CI gate to verify the seeded count before running the load test.

### 6.3 Redis — minimal manifest

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: redis, namespace: iocheck }
spec:
  replicas: 1
  selector: { matchLabels: { app: redis } }
  template:
    metadata: { labels: { app: redis } }
    spec:
      containers:
        - name: redis
          image: redis:7.4-alpine
          args: ["--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru", "--save", ""]
          ports: [{ containerPort: 6379 }]
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 384Mi }
          readinessProbe:
            tcpSocket: { port: 6379 }
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata: { name: redis, namespace: iocheck }
spec:
  selector: { app: redis }
  ports: [{ port: 6379 }]
```

Tradeoff: **ephemeral storage is fine for an LRU cache.** `--save ""` disables RDB snapshots; data is lost on pod restart. That's intentional — Redis is the cache, Postgres is the source of truth. Add a PVC only if you're using Redis for sessions or anything you can't reconstruct.

`maxmemory-policy allkeys-lru` makes the cache self-cleaning under memory pressure.

---

## 7. Dockerfile for Bun (production-shaped)

```dockerfile
# syntax=docker/dockerfile:1.7
# ---------- deps ----------
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

# ---------- build (optional, only if compiling) ----------
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY src ./src
COPY tsconfig.json ./
# Compile to a single binary; targets glibc since the final stage is debian-slim
RUN bun build --compile --minify --sourcemap --bytecode \
    --target=bun-linux-x64-modern \
    ./src/server.ts --outfile /out/iocheck

# ---------- runtime (Option A: interpreted) ----------
FROM oven/bun:1.3-slim AS runtime-interp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./
USER bun
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=2s --retries=3 \
  CMD bun --eval "fetch('http://localhost:3000/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["bun", "run", "src/server.ts"]

# ---------- runtime (Option B: compiled, smaller) ----------
FROM gcr.io/distroless/base-debian12 AS runtime-compiled
COPY --from=build /out/iocheck /iocheck
USER nonroot
EXPOSE 3000
ENTRYPOINT ["/iocheck"]
```

Build either target with `docker build --target=runtime-interp` or `--target=runtime-compiled`.

Notes:
- `bun.lock` (text JSON) is the current lockfile — not `bun.lockb` (binary, deprecated). Bun 1.2+ uses `bun.lock` by default.
- `--mount=type=cache` is a BuildKit feature; speeds up reinstalls. Set `DOCKER_BUILDKIT=1` if not on by default.
- `USER bun` (id 1000) is preset in the official image. With distroless, use `nonroot`.
- Don't include `bun:test` in the runtime stage — only `--production` deps.
- Alpine vs distroless vs slim:
  - **slim** (Debian 12 slim): good libc compat (glibc), ~90MB before adding node_modules. Easiest debugging via `kubectl exec`.
  - **alpine** (musl): smallest base, ~50MB. Watch for musl-incompatible npm modules (rare for Bun apps but possible if you pull in N-API addons). Use `--target=bun-linux-x64-musl` for `--compile`.
  - **distroless**: no shell, no package manager. Best for prod hardening, worst for ad-hoc debugging. Use the compiled binary path.

For this exercise: ship `runtime-interp` with `oven/bun:1.3-slim`. Mention the compiled+distroless variant as a "next step."

---

## 8. Anything changed or broken — gotchas summary

- **Bun.sql is still adding features.** No COPY/LISTEN/NOTIFY. No column-name transform (snake/camel). BIGINT returns strings by default. Multidimensional arrays and NULL-in-arrays not supported. The roadmap is in the docs but no firm dates.
- **Bun.redis transactions** must use raw `send("MULTI", ...)` / `send("EXEC", ...)`. No Sentinel or Cluster.
- **Bun.redis Pub/Sub is experimental** (since 1.2.23) but stable enough for non-critical fan-out.
- **prom-client + Bun:** `collectDefaultMetrics()` may crash on `monitorEventLoopDelay` (issue #18300). Skip default metrics or filter the failing collector.
- **Bun.serve `idleTimeout` defaults to 10s** — includes handler think-time. Will reset connections on slow DB queries under load unless raised.
- **Bun doesn't auto-handle SIGTERM.** You must `process.on("SIGTERM", ...)` and call `server.stop()`. Pair with a "readyz failing → sleep → stop" pattern so kube-proxy unregisters before draining.
- **KEDA + AverageValue is divisive.** The HPA divides by replicas internally. Don't pre-divide in PromQL. Single most common KEDA bug per the kedacore discussions.
- **KEDA `cooldownPeriod` only governs N→0.** N→1 stabilization is HPA's job — configure under `advanced.horizontalPodAutoscalerConfig.behavior.scaleDown.stabilizationWindowSeconds`.
- **Prometheus 3.x still requires `--web.enable-remote-write-receiver` explicitly** despite docs saying it's default. k6 push will 404 silently otherwise.
- **kube-prometheus is RAM-hungry.** Default ask is ~2GB just for Prometheus + Grafana + node-exporter + alertmanager. Strip alertmanager/blackbox-exporter for the demo and cap Prometheus retention to 6h.
- **kind `kindest/node` versions matter.** Match Kubernetes feature gates to KEDA's tested versions (KEDA 2.19 supports K8s 1.27+). Pin `kindest/node:v1.32.0` or v1.33.x.
- **`kind load docker-image` is per-node-set.** Re-loading after adding a node is on you.
- **k6 v2.0.0 changed image base** but the `grafana/k6:2.0.0` tag is stable. `latest` works but pin for reproducibility.
- **k6's `--out experimental-prometheus-rw`** is still tagged experimental in the flag name but production-stable; just be aware the flag name may change.
- **bun.lock vs bun.lockb:** Bun 1.2+ writes `bun.lock` (JSON). Older repos with `bun.lockb` still work; do not commit both.
- **Anthropic acquired Bun in late 2025.** Long-term viability story is strong (Bun powers Claude Code). Watch the open-issue count (~4,800 in late 2025) — quality dips correlated with the 1.3 feature sprint. Pin versions in CI.

---

## 9. Stack version pin matrix (suggested)

| Component                  | Pinned version                    | Notes                                       |
| -------------------------- | --------------------------------- | ------------------------------------------- |
| Bun                        | `oven/bun:1.3` (Debian) / `:1.3-slim` | Use the latest 1.3.x point release         |
| Postgres                   | `postgres:17-alpine`              | 17.x is current stable                      |
| Redis                      | `redis:7.4-alpine`                | Bun.redis supports 7.2+                     |
| kind                       | v0.31.0                           | `kindest/node:v1.32.0`                      |
| Kubernetes (in kind)       | v1.32                             | KEDA 2.19 supported floor                   |
| KEDA                       | v2.19.0 (manifest install)        | `keda-2.19.0.yaml`                          |
| kube-prometheus            | v0.17.0                           | March 2026 release                          |
| Prometheus                 | shipped by kube-prometheus (~v3.x) | enable `enableRemoteWriteReceiver: true`   |
| Grafana                    | shipped by kube-prometheus        | Default dashboards usable                   |
| k6                         | `grafana/k6:2.0.0`                | Use ramping-arrival-rate executor           |
| prom-client                | npm `prom-client@^15.1.2`         | Bun-friendly since 15.1.2                   |
| postgres.js (fallback)     | npm `postgres@^3.4.9`             | Drop-in if Bun.sql limitations bite         |

---

## 10. Recommended implementation order (informs the plan)

1. **Local Bun service + bun:test against ephemeral schema.** Stand up `Bun.serve` + Bun.sql + Bun.redis + prom-client. Validate /metrics format.
2. **Dockerfile + `kind` cluster up.** `runtime-interp` image, load via `kind load docker-image`. Plain Deployment + Service first; no autoscaling yet.
3. **Postgres StatefulSet + Redis Deployment + seed Job.** Verify the seed Job idempotency (`ON CONFLICT DO NOTHING`).
4. **kube-prometheus install + ServiceMonitor + label the namespace.** Confirm scraping in Prometheus UI.
5. **KEDA install + ScaledObject.** Start with `metricType: AverageValue` on `sum(rate(http_requests_total{service="iocheck"}[1m]))`, threshold 50 RPS/pod, min=1 max=20. Add fallback.
6. **k6 Job + Prometheus remote-write output.** Run 60s/4min/5min profile against `ClusterIP`. Watch Grafana panels showing replicas, RPS, p95, in-flight.
7. **Tune.** Most likely fixes: raise Bun `idleTimeout`, lower `max` on Bun.sql pool, tighten HPA `scaleDown.stabilizationWindowSeconds` if scale-down is too aggressive, increase Postgres `max_connections`.

---

## Sources (selected)

- Bun docs: <https://bun.com/docs/api/http>, <https://bun.com/docs/api/sql>, <https://bun.com/docs/api/redis>, <https://bun.com/docs/cli/test>, <https://bun.com/docs/bundler/executables>, <https://bun.com/blog/bun-v1.3>
- KEDA: <https://keda.sh/docs/latest/deploy/>, <https://keda.sh/docs/latest/reference/scaledobject-spec/>, <https://keda.sh/docs/latest/scalers/prometheus/>, <https://keda.sh/docs/latest/concepts/scaling-deployments/>, <https://github.com/kedacore/keda/discussions/3035>
- kind: <https://kind.sigs.k8s.io/docs/user/quick-start/>, <https://kind.sigs.k8s.io/docs/user/configuration/>
- k6: <https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/ramping-arrival-rate/>, <https://grafana.com/docs/k6/latest/results-output/real-time/prometheus-remote-write/>, <https://hub.docker.com/r/grafana/k6/tags>
- Prometheus / kube-prometheus: <https://github.com/prometheus-operator/kube-prometheus>, <https://prometheus-operator.dev/docs/getting-started/installation/>, Prometheus remote-write-receiver flag (issue prometheus/prometheus#16209)
- Bun + prom-client compatibility: <https://github.com/oven-sh/bun/issues/18300>, <https://github.com/siimon/prom-client>
- Postgres.js: <https://github.com/porsager/postgres>
