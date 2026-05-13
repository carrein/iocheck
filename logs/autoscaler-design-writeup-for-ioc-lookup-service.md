# Session: Autoscaler design writeup for IOC lookup service

## User

# iocheck — Writeup

Per the [EXERCISE.md](./EXERCISE.md) deliverables: architecture, answers to the four challenges, behavior when the autoscaler's data source is itself unavailable, and one thing I'd do differently with another week. For the operational quick-start see [README.md](./README.md).

All measured numbers in this document are from runs on a local 4-node `kind` cluster (1 control-plane + 3 workers) on a single macOS host. Cluster spin-up: `make up`. Reproduce with `make load-rps-mixed`; compare with `make load-cpu-mixed` (baseline) or any other `make load-*` target.

## Contents

- [Architecture](#architecture)
- [Design rationale](#design-rationale)
  - [Assumptions](#assumptions)
  - [Services](#services)
  - [Autoscaling](#autoscaling)
  - [Operational baselines](#operational-baselines)
  - [Testing strategy](#testing-strategy)
  - [Future improvements](#future-improvements)
- [Measured evidence](#measured-evidence)
  - [Challenge 1 — Why CPU-based HPA is wrong](#challenge-1--why-cpu-based-hpa-is-wrong-measured)
  - [Challenge 2 — Pods share load](#challenge-2--pods-share-load)
  - [Challenge 3 — Autoscaler scales up and down](#challenge-3--autoscaler-that-scales-up-and-down)
  - [Challenge 4 — Reproducible test](#challenge-4--reproducible-test)
- [What this test reveals about RPS scaling](#what-this-test-reveals-about-rps-scaling)
- [Failure mode: Prometheus is down](#failure-mode-what-if-prometheus-is-down)
- [Given another week](#given-another-week)
- [Production caveats](#production-caveats)

---

## Architecture

```
┌────────┐  POST /lookup,/ioc      ┌──────────────────────────────────┐
│  k6    │ ──────────────────────► │   iocheck:dev   (Bun + Elysia)   │
│ (host) │                         │   replicas: 2-8                  │
└────────┘                         │   probes: healthz/readyz/startup │
     ▲    NodePort 30080           │   metrics: /metrics (prom-client)│
     │    ↔ host:18080             └──────────────┬───────────────────┘
                                                  │
                                ┌─────────────────┼─────────────────┐
                                ▼                 ▼                 ▼
                          ┌──────────┐     ┌──────────┐     ┌──────────────┐
                          │ Postgres │     │  Redis   │     │  Prometheus  │
                          │   16     │     │    7     │     │  (monitoring)│
                          └──────────┘     └──────────┘     └──────┬───────┘
                                                                   │ pulls
                                                                   ▼
                                                          ┌─────────────────┐
                                                          │      KEDA       │
                                                          │  ScaledObject   │
                                                          │  → managed HPA  │
                                                          └─────────────────┘
```

**Stack:** Bun 1.3.11 + Elysia 1.4 (TypeScript), Postgres 16-alpine, Redis 7-alpine, Prometheus v2.55, KEDA 2.19. All decisions and version pins are defended below in [Design rationale](#design-rationale).

**Request path:** client → NodePort → Service → one of N iocheck pods → cache lookup (Redis) → on miss, DB lookup (Postgres) → on miss, store nothing (negative caching out of scope, see [Given another week](#given-another-week)). `POST /ioc` is **write-through** — DB upsert then immediate `SETEX` of the new value into Redis to close the stale-read race.

**Autoscaler path:** iocheck pods expose `/metrics` → Prometheus scrapes via pod-annotation discovery → KEDA polls Prometheus every 15s for `sum(rate(http_requests_total{service="iocheck"}[1m]))` → KEDA computes desired replicas with AverageValue semantics (`ceil(currentReplicas × currentMetric / threshold)`) and updates a managed HPA → HPA drives the Deployment.

---

## Design rationale

Forward-looking record: the assumptions, picks, and operational baselines that shape the build. The [Measured evidence](#measured-evidence) section is the backward-looking proof that these choices held up under load.

### Assumptions

The brief leaves several things open. These are the defaults this build runs against — each is documented so the reviewer knows where a call was made.

1. **Persistent store: Postgres.** ~1M rows expected; access pattern is point lookup + upsert by `(type, value)`. Relational fits without reaching for anything exotic.
2. **Burst shape: both hot-key and wide-unknown.** Cache trivially absorbs hot-key bursts; the wide-unknown case is what the autoscaler must defend. Load test covers both.
3. **Sizing: ~200 RPS baseline → ~2k spike.** Testing autoscaler *behavior* on a laptop-sized cluster, not raw throughput.
4. **Verdict semantics: presence == malicious.** If `(type, value)` is in the DB, verdict is `malicious`; score is informational. Matches the spec's `verdict` wording.
5. **Write pattern: low-rate continuous.** `POST /ioc` invalidates the matching cache key on upsert. No batch ingestion path.
6. **Auth: none.** `POST /ioc` is open; cluster-internal Service only.
7. **IOC lifetime: immortal.** Entries don't expire. Cache TTL ~5 min as a freshness/cost tradeoff.
8. **p99 < 200ms is steady-state, not strict-throughout.** A brief latency excursion during the ~30s scale-up window after a burst hits is acceptable; the SLO is defended *after* scale-up stabilizes. Strict-throughout enforcement would need predictive scaling, baseline over-provisioning, or pre-warming — see [Future improvements](#future-improvements).

### Services

The full stack, grouped by where it runs. Each pick is "boring + defensible on the follow-up call."

#### Cluster

| Component | Pick | Why |
|---|---|---|
| Local k8s | `kind` | Most-used in this space, Docker-native, reproducible. |
| Autoscaler controller | KEDA | Reads Prometheus, scales the Deployment via a `ScaledObject`. The non-CPU autoscaling answer. |
| HPA backbone | metrics-server | Required by k8s for any HPA, KEDA included. |
| Metrics scrape + storage | Prometheus (standalone) | No Grafana in the core stack — the demo uses `kubectl`, raw `/metrics`, and KEDA events. (Grafana is optional: `make grafana-install` — see README.) |

#### Workload (in-cluster)

| Component | Pick | Why |
|---|---|---|
| `iocheck` service | Bun + Elysia | Bun gives native TS + perf headroom toward p99 < 200ms; Elysia is the Fastify-equivalent with built-in TypeBox validation. |
| Database | Postgres — raw StatefulSet, official `postgres` image, single replica | Schema is fixed and small; init SQL via ConfigMap. Every line is ours — no chart dependency to trust or explain on the call. |
| Cache | Redis — raw StatefulSet, official `redis` image, single replica | Read-through with TTL; invalidate on `POST /ioc`. Same reasoning as DB — no chart needed for a single replica. |

#### App-layer dependencies

- **DB driver:** `postgres.js` — raw SQL via tagged templates, no ORM, no codegen. One table doesn't need more.
- **Cache client:** `ioredis` — canonical Redis client, works under Bun's Node compat.
- **Metrics:** `prom-client` — canonical Prometheus exposition for Node/Bun.
- **Validation:** Elysia + TypeBox (built-in).
- **Logger:** Bun's built-in `console` — no extra dependency, sufficient for this exercise.
- **Tests:** `bun test` — built into the runtime.
- **Migrations:** init SQL via ConfigMap mounted by the Postgres chart — schema is fixed.

#### Out-of-cluster tooling

- **Docker** — image build (`kind load docker-image` to ship into the cluster, no registry needed).
- **`kubectl`, `helm`** — apply manifests, install charts.
- **`kind` CLI** — cluster lifecycle.
- **`k6`** — load test driver. JS-scripted scenarios cleanly express hot-key vs. wide-unknown bursts.
- **`make`** — single entrypoint (`make up`, `make load`, `make down`). Fail-fast dependency checks at the top with pinned versions for kind / kubectl / docker / k6. Live demo runs from the candidate's laptop; the same Makefile reproduces on a fresh reviewer machine.

#### Explicitly skipped

- **Frontend** — load test tool is the user simulator; UI deferred to [Future improvements](#future-improvements).
- **ORM (Drizzle / Prisma / MikroORM)** — overkill for one table; raw SQL is more defensible.
- **Service mesh, ingress controller, cert-manager** — NodePort is enough for a local demo with no auth.
- **External DB/cache HA** — single-replica with PDB is fine for this exercise; HA noted in [Future improvements](#future-improvements).

### Autoscaling

The single hardest design call in the brief. **Primary trigger: RPS per pod, read from Prometheus by KEDA.** In-flight concurrency and p99 latency are emitted and observed, but not used as scaling signals. CPU is dismissed with measured evidence (see [Challenge 1](#challenge-1--why-cpu-based-hpa-is-wrong-measured)).

This is a *baseline*. Real production traffic will not match synthetic k6 load exactly; the right move is to revisit the trigger after observing real SOC alert patterns. [Future improvements](#future-improvements) lists this explicitly.

#### Why RPS — the pivot in plain terms

The other Claude did literature research and changed its mind. The pivot in plain terms:

**Old recommendation:** scale on in-flight requests (the concurrency signal Knative uses).

**New recommendation:** scale on RPS (the signal Zalando uses, a closer-shape precedent for our workload).

**Why the change, restaurant analogy:**

Imagine a restaurant where some customers order coffee (1 minute, easy) and others order a seven-course tasting menu (90 minutes, expensive).

- "How many customers are currently inside" (in-flight) sounds smart, but one tasting-menu customer counts the same as 90 coffee-worth-of-work customers. The number gets distorted when you mix fast and slow request types.
- "How many customers walk in per minute" (RPS) is honest: incoming load is incoming load, regardless of whether they want coffee or the tasting menu.

iocheck has exactly this problem. Cache hits are coffee (~1ms). Cache misses are tasting menus (~10-50ms, ten to fifty times slower). In-flight averages will be noisy because one in-flight cache-miss is worth dozens of in-flight cache-hits, and the in-flight number cannot tell them apart.

**The other shift:**

Knative was the original precedent, but Knative was built for serverless functions where every request costs about the same. Zalando is a German fashion retailer running hundreds of cache-friendly HTTP services at very large RPS, which is much closer to iocheck's shape. They published their autoscaler (kube-metrics-adapter) with documented RPS-based reasoning. Better-matched precedent.

**What stays the same:**

- In-flight and p99 still get measured and shown in the measured evidence section, just not as scaling triggers.
- The "CPU is wrong" demonstration still stands as the central deliverable.
- The KEDA `fallback` block for the failure-mode answer still applies.

**Net:** small refinement, not a redirection. RPS as the primary trigger, in-flight and p99 as supporting evidence, more research citations to defend the choice in the interview.

#### Why CPU is wrong (with citations)

For a Bun/Node service fronted by Redis, CPU is a lagging indicator that systematically under-reports load:

- **Brendan Gregg's USE method** ([source](https://www.brendangregg.com/usemethod.html)): "A resource at 60% utilization with significant saturation is a bigger problem than one at 90% utilization without saturation." Cache lookups and DB IO show up as saturation (queue depth, in-flight), not CPU.
- **Kedify's timing math** ([source](https://kedify.io/resources/blog/autoscaling-delay-resource-based-hpa-vs-proactive-metrics/)): "With Prometheus scraping once per minute and HPA syncing every 15 seconds, you can be 30–90 seconds late to a 20-second spike — that's how p95 slips while CPU looks normal."
- **Tinybird's post-mortem** ([source](https://www.tinybird.co/blog/scaling-with-keda-and-tinybird)): "CPU spikes *after* your system is already overwhelmed... When new pods finally spin up, user requests may have already been delayed."
- **Cloudflare Gagarin** ([source](https://blog.cloudflare.com/scalable-machine-learning-at-cloudflare/)) — closest published workload analog (Redis-fronted feature lookup) — saw p99 climb during peaks while CPU averages stayed flat. They moved to cache-hit-ratio + tail latency.

#### Why RPS over in-flight (with citations)

Both are defensible; the literature converges on these two as the shortlist. The deciding factor for iocheck is **request-cost heterogeneity**:

- **Knative KPA** ([docs](https://knative.dev/docs/serving/autoscaling/)) defaults to in-flight concurrency, which works best when per-request cost is uniform.
- **Red Hat's KServe writeup** ([source](https://developers.redhat.com/articles/2025/11/26/autoscaling-vllm-openshift-ai-model-serving)) flags the failure mode directly: KPA gets fragile when "a few heavy requests saturate a pod while concurrency count looks low." iocheck has exactly this — cache hits and cache misses differ by 10–50× in cost.
- **Zalando's Skipper + kube-metrics-adapter** ([repo](https://github.com/zalando-incubator/kube-metrics-adapter)) is the closest published precedent: hundreds of cache-fronted HTTP services scaled on RPS via Prometheus, at 500k–7M RPS. Built and open-sourced precisely because "there's a nonlinear correlation between CPU/memory and throughput."
- **Little's Law** ([Dan Slimmon](https://blog.danslimmon.com/2022/06/07/using-littles-law-to-scale-applications/)): `L = λW`. Concurrency, RPS, and latency are linked by the same equation — picking RPS doesn't lose information, it picks the cleanest variable to read empirically.

#### Failure mode (design)

**What if Prometheus is unavailable?** KEDA holds the Deployment at `minReplicaCount` (2). Service stays up; elastic scaling stops until metrics return. KEDA's `fallback:` field on the `ScaledObject` can specify a higher replica count if metrics go stale beyond a threshold — Datadog and Kedify both flag this as table stakes. Detection: alert on `up{job="prometheus"} == 0` and on KEDA controller events. Measured behavior in [Failure mode: Prometheus is down](#failure-mode-what-if-prometheus-is-down).

#### Threat-intel context (worth flagging)

No public posts from VirusTotal, AbuseIPDB, GreyNoise, MISP, or AlienVault OTX on autoscaling signal choice. They visibly shape demand with **API quotas** (AbuseIPDB 1k/day, VirusTotal 500/day, GreyNoise 50/week) rather than relying purely on autoscaling. Implication: rate-limiting at the edge is a complementary lever to autoscaling, not a replacement — explicitly out of scope for this exercise.

### Operational baselines

Concrete values that go directly into the manifests. Locked once the higher-level design above commits. Each is a "good starting point" — the testing section's Phase F load runs tune them against measured data.

#### Resource requests / limits

| Container | Requests | Limits | Reasoning |
|---|---|---|---|
| `iocheck` | `750m` / `128Mi` | `1500m` / `512Mi` | Sized for production-realistic burst headroom + bin-packing (VPA's "p95 of historical usage" guidance), not for the local benchmark's steady-state. CPU HPA at 70% of 750m = 525m trigger line — measured per-pod CPU at 1000 RPS/pod is ~190m, so the HPA never fires. That asymmetry *is* the "looks fine, doesn't work" demonstration the brief warns about. See Challenge 1 for the math. |
| `postgres` | `100m` / `256Mi` | `500m` / `512Mi` | Dev-sized single replica. postgres.js pool of 20-30 conns × 2 minReplicas keeps `max_connections=100` headroom. |
| `redis` | `50m` / `64Mi` | `200m` / `256Mi` | Lightweight; cache footprint stays small. |
| `prometheus` | `100m` / `256Mi` | `500m` / `512Mi` | Single replica, emptyDir storage, sized for demo runs. |

#### Autoscaling parameters

| Parameter | Value | Notes |
|---|---|---|
| Per-pod RPS target | **25** | Tuned against measured p99: at 50/pod the scale-up cascade itself caused a 256ms p99 breach during the burst window; at 25/pod KEDA scales pre-saturation and p99 stays at 105ms. See Challenge 3 §"Why 25 rps/pod and not 50". Lives in `manifests/scaling/scaledobject.yaml`. |
| `minReplicaCount` | 2 | Required by spec. |
| `maxReplicaCount` | 8 | Matches the brief's "previous attempt" (`min=2, max=8`) for a like-for-like comparison. |
| `pollingInterval` | 15s | Tuned down from KEDA's 30s default so demo scaling reacts within ~60s. |
| `cooldownPeriod` | 60s | Tuned down from KEDA's 300s default so the "return to 2" demo happens inside a sensible window. |
| `fallback.failureThreshold` | 3 | Consecutive polling failures before fallback fires. |
| `fallback.replicas` | 4 | Half of max, doubles the floor — keeps service comfortably available during a metrics outage. |
| `fallback.behavior` | `currentReplicasIfHigher` | Hold or move up on a Prometheus blip; never scale down. Direct answer to the writeup's "data source unavailable" question. |

#### Cache strategy: write-through

`POST /ioc` flow — write to Postgres, then `SETEX` the new value into Redis with TTL. Not pure invalidation.

- Pure invalidation (`DEL` on upsert) has a race: a concurrent `/lookup` mid-upsert can re-cache the *old* DB value between the upsert committing and the `DEL` landing.
- Write-through eliminates the race for the cost of one extra `SETEX` per upsert. Negligible given assumption #5 (low-rate writes).

### Testing strategy

Two goals: (1) prove the autoscaler works (deliverable #4), and (2) generate the **comparative evidence** that justifies RPS over CPU and the alternatives. Both run on the same load-test harness (k6) against the same cluster.

#### Triggers under test

| Variant | Trigger | Hypothesis |
|---|---|---|
| Baseline | CPU HPA at 70% | Replicas barely scale; p99 climbs unbounded. The "wrong answer" the brief warns about. |
| **Proposed** | **RPS per pod (KEDA Prometheus scaler)** | **Replicas track RPS linearly; p99 stays under 200ms across both burst shapes.** |
| Alternative A | In-flight per pod (Knative-style) | Reacts well to wide-unknown bursts (DB-bound, requests pile up); under-scales on hot-key bursts where requests are fast. |
| Alternative B | p99 latency | Lagging — by the time p99 climbs, users already saw bad latency. Works as a guardrail, not a primary signal. |
| Alternative C | Multi-trigger (RPS OR p99) | Belt-and-suspenders: RPS for proactive scaling, p99 as a safety net. Adds explanation overhead. |

#### Burst shapes

From assumption #2 — both must work:

- **Hot-key burst** — k6 hammers a small set of pre-warmed IOCs; cache absorbs nearly all traffic.
- **Wide-unknown burst** — k6 generates random unknown values; cache misses, DB does the work.
- **Mixed burst** — ~80% hot keys, ~20% wide unknowns; realistic SOC traffic shape.

#### Load-generator connection settings

All three k6 scenarios set `noVUConnectionReuse: true`. Each VU iteration opens a fresh TCP connection, runs one request, and closes it.

Why: kube-proxy load-balances at the TCP-connection level (iptables hash at connect time), then pins all subsequent requests to that backend pod. With HTTP keep-alive on (k6's default), a long-running VU would send thousands of requests to one pinned pod. When KEDA scales out from 2 → 8 pods during a burst, the existing connections stay on the original two pods — the five new pods sit idle, and the CPU panel shows a 50/30/2/2/2/2/2 % distribution that makes the autoscaler look broken even when it isn't.

Cycling the connection per iteration forces kube-proxy to re-hash the backend each time, so load fans out across all live pods within ~10-30s of scale-up. This is also closer to how short-lived real clients (browsers, agents) hit the service. In a production deployment the equivalent solution is an L7 load balancer in front (envoy / nginx ingress / cloud ALB) or a service mesh.

#### Metrics captured per run

For each (variant × burst shape) cell:

- Replica count over time
- p50 / p95 / p99 latency
- RPS observed
- In-flight requests
- CPU utilization
- Time-to-scale (first scale-up event after burst start)
- Time-to-recover (replicas back to 2 after burst ends)

#### Acceptance criteria

The proposed trigger (RPS) passes if, across all three burst shapes:

- p99 < 200ms after scale-up stabilizes (≤ 30s into the burst)
- Replicas return to 2 within 5 minutes of load stopping
- First scale-up event fires within 30 seconds of burst start

#### Failure-mode test

A separate run kills Prometheus mid-burst to validate **fallback** behavior: replicas should hold (or move to the configured fallback count), service stays up, recovery happens once metrics return. This is the writeup's explicit "data source unavailable" answer.

#### Reproducibility

Each `make load-*` target runs end-to-end (reset → scaler → k6 → cooldown) and writes a single-row summary CSV to `artifacts/<TS>-<scenario>.csv`. Reproduce from a clean cluster via `make up && make load-rps-mixed && make down`.

### Future improvements

Out of scope for this exercise, captured here so they don't get lost:

- **Auth on `/ioc`.** Currently open; production would need at least a shared secret, ideally mTLS or an admin token.
- **IOC expiry / TTL semantics.** `added_at` could drive an expiry policy; entries currently live forever.
- **Batch ingestion.** `POST /ioc` is fine for a trickle; bulk feeds (MISP exports, AbuseIPDB dumps) want a dedicated path.
- **Analyst-facing UI.** A small React (or static) frontend over `/lookup` would make demos more tangible.
- **Postgres / Redis HA.** Single replicas leaning on PDB + cache to soften the SPOF; replica + pgbouncer / Redis Sentinel are the production move.
- **Structured logging.** Bun's `console` is fine here; pino + a log aggregator (Loki / CloudWatch) is what production wants.
- **Service mesh (Linkerd).** Free per-pod RPS / latency metrics if app-level emission ever becomes unreliable.
- **Grafana dashboards.** Skipped from the core stack to keep the install minimal; available via `make grafana-install` (optional).
- **Strict p99 SLO enforcement (throughout-burst, not steady-state).** Current acceptance is relaxed (post-stabilization). Defending the strict reading needs one of: predictive / pre-emptive scaling, baseline replica over-provisioning, request-level priority shedding, or warm pools. Worth flagging in the "given another week" reflection.

---

## Measured evidence

A backward-looking record of what the load suite measured and what those measurements imply. Answers the four challenges from [EXERCISE.md](./EXERCISE.md) with data the harness actually captured.

### Challenge 1 — Why CPU-based HPA is wrong (measured)

#### The structural argument

For a cache-fronted lookup service, **per-request CPU is decoupled from request rate**. Each `/lookup` is a Redis GET (sub-millisecond, mostly IO wait) + JSON serialize. The CPU draw per request is ~0.3ms on this image (Bun + Elysia framework cost); a production-tuned lookup service does it in 10-50µs. Either way, the curve `CPU = f(RPS)` is *flat at the bottom* of the chart over the entire range where the service is healthy. It only bends upward once the event loop saturates — at which point latency has already collapsed.

CPU-based HPA reacts when CPU crosses some target percentage of a *request*. So whether it fires under load depends on **what you set the request to**. Set it small enough and CPU appears to react; set it at production-realistic sizing and CPU stays well below the trigger across the entire useful range. That's the bug the spec describes when it says "pods rarely scale up even when p99 hits 2-3 seconds": real production teams size CPU requests for burst headroom + bin-packing, not for steady-state observed usage, and the resulting request is wide enough that CPU never hits 70% under normal load — even when something else (DB latency, event-loop queuing) is breaking the SLO.

#### Sizing the CPU request

`manifests/app/deployment.yaml` sets `resources.requests.cpu: 750m`. Reasoning:

- **Measured per-pod CPU at peak load** in this image: ~190m at 1000 RPS/pod.
- **Production sizing principle** (k8s VPA guidance): size requests at **p95-p99** of historical usage, not at the mean. The factor between mean and p95 in a bursty workload is typically 2-3×; for the modelled SOC alert-storm workload (idle → 10× spike → idle) it's larger.
- **Bin-packing reality**: a request smaller than peak usage causes node CPU oversubscription during bursts → kernel CPU throttling → tail latency. Production teams size to avoid this, even if the resulting request looks oversized at steady state.
- **750m is the p95-equivalent for the modelled production workload**, not the local sandbox. The synthetic test happens to peak at 190m on this image; a real lookup service serving the same logical load would peak much lower because per-request cost is 10-50µs not 300µs.

This number is the variable the spec is implicitly testing. Set `cpu.requests: 100m` and CPU HPA fires at the slightest activity — but you've also lied about the pod's actual resource footprint and will get throttled in production. Set `cpu.requests: 750m` and the HPA stays silent through realistic load — exposing that CPU is the wrong signal in the first place.

#### The measurement

**CPU HPA × mixed-burst load**: `manifests/scaling/hpa-cpu.yaml`, target=70% utilization.

| | value |
|---|---|
| Peak total RPS | 2125 (2.1× the offered 1000 target) |
| Replicas | **2 → 2** (no scale events) |
| Per-pod CPU peak | ~190m |
| HPA trigger line (70% of 750m) | 525m |
| Peak p99 | 48.6 ms |
| Cache hit ratio | 0.80 |
| Scale-down to min | 0s (never left) |

CPU stayed at **25% of the request through the entire burst.** The HPA's input signal — utilization — never crossed its target, so the controller never produced a scale-up recommendation. The deliverable's claim — *"CPU is the wrong signal"* — is the direct mechanical consequence of two facts measurable in this artifact: (a) CPU per request is flat in this regime, (b) the request is sized for production headroom not benchmark steady-state.

The lucky-but-not-the-point fact: p99 stayed under SLO (48.6ms) because the service itself was fine at 2 pods. A CPU HPA "failure" here doesn't break the system in this benchmark — but it would, if the workload had any of: (i) higher absolute load, (ii) IO-bound bottleneck (DB lock contention, network jitter), (iii) the production sizing on a more efficient runtime where 1000 rps fits in 30m CPU. The point is structural: the signal is uncorrelated with load, so even when something *else* is breaking, CPU stays flat. See [artifact `cpu-mixed`](./artifacts/).

### Challenge 2 — Pods share load

The default Kubernetes Service (`type: NodePort` + ClusterIP) round-robins via kube-proxy iptables rules across all Ready pod IPs. No client-side stickiness, no application-level routing — just the standard pattern.

**Verified at peak (8 replicas, rps-mixed):** measured per-pod RPS across the 8 pods at end-of-load:
```
  iocheck-…-clwn5   198.2 rps   101m cpu
  iocheck-…-f5xtz   202.6 rps   102m cpu
  iocheck-…-h5794   208.6 rps   125m cpu
  iocheck-…-jktqr   216.9 rps   121m cpu
  iocheck-…-jvz9n   225.2 rps   129m cpu
  iocheck-…-n77mz   216.0 rps   108m cpu
  iocheck-…-vgd7h   218.1 rps   127m cpu
  iocheck-…-w7d75   202.7 rps   103m cpu
  spread:  rps cv=4.2%   cpu cv=9.8%
```

cv=4.2% across 8 pods at ~210 RPS/pod is well within the noise floor of random TCP hashing. KEDA reads `sum(rate(http_requests_total{service="iocheck"}[1m]))` and its `metricType: AverageValue` divides by the current replica count — so the autoscaler's input is exactly per-pod-average-RPS, which matches what the load distribution shows.

The PDB (`minAvailable: 2`) ensures that under voluntary disruption (node drain, rolling update) at least 2 pods stay Ready — so load-sharing isn't broken by an upgrade cycle. Anti-affinity is intentionally **omitted** on a single-host kind cluster (workers are docker containers on the same machine; anti-affinity is moot here). It would be the next step on a multi-node production cluster.

**Connection stickiness caveat.** kube-proxy load-balances at the *TCP connection* level, not the request level — once a connection is opened, every subsequent request on it is pinned to whichever backend pod was picked at connect time. With HTTP keep-alive (k6's default), a single VU can send thousands of requests to one pinned pod for the entire run. When KEDA scales 2 → 8, the **existing connections stay on the original two pods**; new pods only see traffic from VUs k6 spins up afterward. The result on the CPU panel is a 50/30/2/2/2/2/2 % distribution, which makes the autoscaler look broken even though it isn't.

The k6 scenarios set `noVUConnectionReuse: true` to close the TCP connection at the end of each iteration. The next iteration reconnects → kube-proxy re-hashes the backend → load fans out evenly across all live pods within ~10-30s of scale-up. In production this same problem is solved by an L7 load balancer in front (envoy / nginx ingress / cloud ALB) or a service mesh; for the load test, cycling connections is the lower-friction equivalent and is also closer to how short-lived real clients (browsers, agents) hit the service.

### Challenge 3 — Autoscaler that scales up and down

**Trigger:** RPS-per-pod, via Prometheus + KEDA. Per-pod target: **25 RPS**. Cooldown: 60s. Min/max replicas: 2/8. ScaleDown stabilization: 60s (override; default is 300s).

#### The measurement

| | value |
|---|---|
| Peak total RPS | 1914 (1.9× the offered 1000 target) |
| Replicas | **2 → 8** then **8 → 2** |
| Peak p99 | **105.8 ms** (under the 200ms SLO) |
| Cache hit ratio | 0.80 |
| Scale events | 3 (up + down) |
| Per-pod RPS spread at peak (cv) | 4.2% (8 pods, 198–225 rps each) |
| **Scale-down to min: time after load stopped** | **107s** |

Three things to read out of those numbers:

1. **Up**: KEDA crossed the 25 rps/pod trigger within one polling interval (15s) of k6's ramp, scaled in two steps to maxReplicas=8.
2. **Stay under SLO**: peak p99 = 105ms, comfortably under the 200ms target throughout the burst — including the scale-up cascade.
3. **Down**: 107s after k6 ended, the deployment was back at min=2. That covers the full path: KEDA cooldownPeriod (60s) + behavior.scaleDown.stabilizationWindowSeconds (60s) + one polling interval — exactly what the configuration predicts.

Reproduce: `make load-rps-mixed`. Artifact: `artifacts/<TS>-rps-mixed.csv` (column `returned_to_min_at_s`).

#### Why 25 rps/pod and not 50

The earlier draft used 50 RPS/pod. Under the bursty mixed load that produced **peak p99 = 256 ms** — *above* the SLO — even though the system did scale to 8. The breach happened in the ~15s window between "RPS crosses threshold" and "new pods Ready"; KEDA was responding to a signal that already indicated saturation, not predicting it. Lowering the threshold to **25 RPS/pod** scales twice as early in the ramp — before queueing builds — and dropped peak p99 to 105 ms. The trade-off is more pods at peak (cost / over-provisioning) for a faster signal; the spec's p99 SLO drives the choice.

Defendable on first principles: "you want to scale *before* saturation, not at the boundary, because the scale-up itself takes pod-warmup time during which latency degrades." Anything tighter than 25 (say, 10) would over-provision; anything wider than 50 breaches SLO under measured load.

#### Why min=2

PDB `minAvailable: 2`. A single voluntary disruption (node drain, rolling update) on a 1-replica deployment violates the contract; min=2 is the minimum consistent with the PDB. Below that we're shipping a fragile baseline regardless of what the autoscaler does.

#### Why max=8

Two bounds:
- **Headroom against the offered 10× spike target** — at 25 rps/pod, 1000 RPS needs 40 pods; we cap at 8 because (a) the in-cluster k6 + 2x-overshoot puts real peak around 1900 RPS = 76 pods, which the local kind cluster cannot fit, (b) production would scale further but that's an EKS-tier concern, not a take-home-on-laptop concern.
- **Kind cluster CPU** — 4 nodes × 10 cpu = 40 cpu allocatable. 8 iocheck pods × 750m + DB + cache + KEDA + Prometheus + k6 Job + system pods fits at ~70% utilization. max=10 would risk Pending pods.

In a production deployment max would be set higher (say 32 or 64) with the same 25 rps/pod trigger. The cluster-size constraint is the binding factor here; the autoscaler logic doesn't change.

#### Scale-down behavior override

`manifests/scaling/scaledobject.yaml` includes:
```yaml
advanced:
  horizontalPodAutoscalerConfig:
    behavior:
      scaleDown:
        stabilizationWindowSeconds: 60
```

Without this override, k8s's default `scaleDown.stabilizationWindowSeconds: 300s` (5 min) dominates KEDA's `cooldownPeriod: 60s`. The default exists for production safety — preventing flap when traffic is bursty around the threshold — but on this take-home's 3-minute load profile it makes scale-down invisible. 60s gives enough hysteresis to avoid immediate ping-pong while letting the deliverable's "return to 2" actually return. In production the value would be re-tuned against measured traffic variance.

### Challenge 4 — Reproducible test

`make up && make load-rps-mixed && make down` runs the rps-mixed scenario from a clean cluster. Each `make load-*` target runs its full lifecycle (reset → scaler → k6 (in-cluster Job) → scale-down poll) and writes a single-row summary CSV to `artifacts/<TS>-<scenario>.csv`:

```
scenario,started_at_iso,duration_s,min_replicas,max_replicas,avg_rps,peak_rps,
target_peak_rps,throughput_pct,avg_p99_ms,peak_p99_ms,cache_hit_ratio,
scale_events,k6_checks_passed,k6_requests_total,passed_p99_threshold,
passed_throughput_threshold,returned_to_min_at_s
```

The last column captures the scale-down half of Challenge 3 — seconds elapsed between k6 ending and replicas returning to `minReplicaCount=2`, or `-1` if not reached within the 300s observation window.

The matrix collapsed to `make load-cpu-mixed` (wrong-signal demo) and `make load-rps-mixed` (right-signal demo). Steady-state hot/wide scenarios were dropped — they were 200-RPS sanity checks that two pods absorbed without effort and didn't validate any of the four challenges. The failure-mode scenario is `make load-failure`.

#### k6 runs in-cluster

The load generator runs as a Kubernetes Job in the `iocheck` namespace (`manifests/loadtest/job.yaml`), with `parallelism: 4` k6 pods hitting `iocheck.iocheck.svc.cluster.local:3000` via the ClusterIP. Reasons:

- **macOS loopback + `noVUConnectionReuse: true` caps at ~220 conn/s** because of ephemeral-port + TIME_WAIT limits. That's well below the 1000 RPS scenario target, so a host-side load test on macOS would chronically under-deliver and the comparison wouldn't be meaningful. The in-cluster path uses pod-network ClusterIP, avoiding the host network stack.
- **Linux pods are similarly bounded** (~467/s per pod). `parallelism: 4` runs four k6 pods in parallel, each driving its own scenario, aggregating to ~1800-2000 RPS — enough to exercise the autoscaler with real burst pressure.
- **No host `k6` dependency.** The tooling image (`tools.Dockerfile`) no longer bundles k6 — the reviewer needs only Docker on the host. The scenario JS is mounted into the Job's pods via a ConfigMap that `run.sh` regenerates from source on every call, so editing `loadtest/scenarios/mixed.js` takes effect on the next run with no rebuild.
- **Summary capture via stdout markers.** k6 exits non-zero on threshold breach (Job → Failed), and pods enter `Completed`/`Error` state — neither supports reliable file extraction. `mixed.js` defines `handleSummary()` to print JSON between `===K6_SUMMARY_START===` / `===K6_SUMMARY_END===` markers; `run.sh` extracts each pod's summary from `kubectl logs` and aggregates the per-pod totals as NDJSON.

---

## What this test reveals about RPS scaling

The brief describes the production symptom as *"pods rarely scale up — even when SOC alert storms drive p99 latency to 2-3 seconds."* The cache-friendly `mixed` workload never reproduces the 2-3s regime (48ms p99 on 2 fixed pods, 105ms scaled to 8). To probe whether the spec's pathology is reachable on this stack at all, we added a second scenario: **`wide`** — same 10× burst envelope as `mixed`, but every request is a random sha256 the service has never seen, so cache hit rate collapses to zero and every lookup hits Postgres.

#### Four-cell measurement

| | cpu-mixed | rps-mixed | cpu-wide | rps-wide |
|---|---|---|---|---|
| Cache hit | 0.80 | 0.80 | **0.00** | **0.00** |
| Replicas | 2 → 2 | 2 → 8 | 2 → 2 | 2 → 8 |
| Peak RPS | 2125 | 1914 | 1981 | 1993 |
| Peak p99 | 48ms ✓ | 106ms ✓ | 85ms ✓ | **802ms ✗** |
| Per-pod CPU peak | 190m | 130m | 280m | 165m |
| Scale events | 0 | 3 | 0 | 3 |
| Return to min | — | 107s | — | 102s |

Three findings stack:

**1. CPU is the wrong signal in all four scenarios.** Across both cache-friendly and cache-miss bursts, per-pod CPU never crosses the 70% of 750m = 525m trigger. CPU HPA fires zero times in either `cpu-*` artifact. The spec's hint is confirmed: CPU is structurally below the trigger line for this service, regardless of cache behavior.

**2. The DB becomes the bottleneck under the cache-miss burst — and adding more iocheck pods makes it worse.** `rps-wide` is the killer datum. With 2 fixed pods, the all-miss burst lands at 85ms p99 — comfortably under SLO. KEDA, watching only RPS, scales to 8 pods on the same load. Each iocheck pod has its own postgres.js connection pool (default ~30 connections); 8 pods × 30 = 240 connections requested against Postgres `max_connections=100`. Pool saturation → connection-wait queue inside iocheck → request queue depth grows → **peak p99 jumps to 802ms**, 4× the SLO. RPS-based scaling didn't fail to fix the problem — it *caused* the problem by ignoring downstream capacity.

**3. The mechanism is the same one the brief alludes to.** A real SOC alert storm doesn't just raise RPS — it changes the *shape* of the workload (cache misses, IO-bound queries, lock contention). Per-request CPU stays low because the bottleneck is downstream. Both CPU and RPS triggers miss this: CPU because the service isn't CPU-bound, RPS because RPS is an input signal, not a saturation signal. **The right signal is a saturation metric** — p99 latency, in-flight requests, or downstream wait-time — something that *measures* whether the system is healthy, not what it's being asked to do.

#### Implication for the scaler choice

`rps-wide` doesn't invalidate the chosen scaler for *the mixed workload*. On `mixed`, RPS scaling works: it scales up before SLO is breached, scales back to min in 107s, and the overprovisioning is a cost question, not a correctness one. But the four-cell table makes the principled answer obvious: **for a cache-fronted service backed by a finite-pool DB, the correct scaling signal is a saturation metric, not RPS.** KEDA supports this directly via Prometheus triggers on `histogram_quantile(0.99, …)` or `sum(http_inflight_requests)`. We've shipped the RPS scaler because (a) it's the industry default and operationally simpler, (b) latency-based triggers need careful `stabilizationWindowSeconds` tuning to avoid flap, and (c) the *real* fix to the rps-wide pathology isn't just a different scaler — it's also a Postgres connection pooler (pgbouncer) and/or a per-pod pool sized so `pods × pool_size ≤ max_connections`.

#### Open question for the call

> *"Our `wide` scenario reproduces the spec's high-p99 / low-CPU pathology — peak p99 ≈800ms when the cache is bypassed. The interesting finding: RPS-based scaling makes it worse, because adding iocheck pods saturates the Postgres connection limit. We'd recommend switching the trigger to a saturation signal (in-flight requests or p99 latency) and adding pgbouncer in front of Postgres, but both are bigger changes than this take-home covers. **In your current production, when p99 hits 2-3s during an alert storm: are the iocheck pods CPU-idle but with queued requests, are they waiting on the DB, or is the DB itself overloaded?** The answer determines whether the fix is latency-based scaling, DB-side pool management, or both."*

---

## Failure mode: what if Prometheus is down?

KEDA's `ScaledObject.fallback` block is the explicit answer:

```yaml
fallback:
  failureThreshold: 3                       # 3 consecutive polling failures
  replicas: 4                               # half of maxReplicaCount
  behavior: currentReplicasIfHigher         # KEDA 2.19+
```

`behavior: currentReplicasIfHigher` means: if the current replica count is already higher than the fallback target, keep it. The wrong move during a real burst would be to suddenly scale down to 4 just because the metrics source blipped. This setting prevents that.

**Verified empirically.** `make load-failure` runs the mixed scenario, scales Prometheus to 0 at T+75s, holds the outage for 90s (covering the `failureThreshold: 3` × 15s = 45s gate plus headroom), then restores. Summary written to `artifacts/<TS>-failure.csv`. Key transitions (sampled every 5s):

| t (s) | replicas | RPS | prom_pods | SO.fallback |
|---|---|---|---|---|
| 0   | 2 | 4    | 1 | Unknown |
| 60  | 2 | 278  | 1 | False (active scaling) |
| 75  | 4 | 422  | 1 | False — Prom scale to 0 issued here |
| 110 | 4 | -    | 0 | False — still in failureThreshold window |
| 130 | 6 | -    | 0 | **True** — fallback activated |
| 165 | 6 | -    | 1 | True — Prom restored |
| 180 | 6 | -    | 1 | **False** — fallback released, normal scaling resumed |
| 200 | 6 | 0.3  | 1 | False — load ending, normal cooldown |

Two observations worth flagging:

1. **The service did not break.** 82,509 k6 requests, **0 failures**, max latency 42ms during the outage window. From the user's perspective, Prometheus going down was invisible.
2. **Replicas climbed during the outage** (4 → 6 just after Prom went down) — KEDA was still acting on the *last successful poll* before fallback activated. After the failureThreshold gate fired, `currentReplicasIfHigher` held the higher count rather than collapsing to the fallback floor of 4. After recovery, normal scaling resumed within ~15s.

Detection in production would lean on two signals: an alert on `up{job="prometheus"} == 0`, and KEDA controller events (`kubectl get events -n keda`). The fallback mechanism keeps the user-facing service available; the alert covers the operator-facing "your autoscaler is flying blind" problem.

---

## Given another week

Out of scope for this submission, listed in priority order:

1. **Strict-throughout p99 SLO.** Current acceptance is steady-state (post-stabilization) per assumption #8. Defending the throughout-burst reading needs either predictive scaling (e.g., projecting from RPS slope), baseline over-provisioning, or warm pools — all three add complexity worth a week to evaluate.
2. **Postgres / Redis HA.** Single replicas leaning on PDB and the cache; production would add at least a Postgres replica + pgbouncer and Redis Sentinel.
3. **Bun.SQL / Bun.redis swap.** Both are ~7-9× faster than postgres.js / ioredis but neither is a drop-in API. Swap is mechanical given the small DB and cache modules; defensibility on the call wins for this submission (postgres.js and ioredis are mature and well-known).
4. **Sweep the RPS threshold against a wider range of workloads.** Current value (25 rps/pod) was tuned for the bursty mixed scenario at 1000 RPS offered. A production deployment would also measure under sustained steady-state and against IO-bottlenecked traffic patterns (e.g., DB slow-query bursts) to validate the choice doesn't over- or under-provision in regimes we haven't tested.
5. **Anti-affinity + multi-host.** Useful when there are real nodes; moot on single-host kind.
6. **cAdvisor scraping in Prometheus.** Gives historical per-container CPU/memory from the kubelet, replacing the `kubectl top pods` polling in `run.sh` with a queryable time series.
7. **Service mesh (Linkerd) for free per-pod RPS / latency metrics.** Would remove the app's responsibility for emitting accurate request metrics if instrumentation ever drifts.
8. **Analyst-facing UI.** A small frontend over `/lookup` for demos; not included in this submission.

---

## Production caveats

A few things worth flagging explicitly to whoever inherits this:

- **Host port shift.** The kind cluster maps NodePort 30080 → host port `18080` (not 8080) because macOS Docker Desktop has a hidden binding on 8080 that `lsof` doesn't show. Documented in the Makefile and `manifests/kind.yaml`.
- **metrics-server `--kubelet-insecure-tls`.** Required on kind (self-signed kubelet certs); never use in production.
- **CPU HPA toggle is here only for comparison.** Default `make up` ships no autoscaler; `make scale-rps` is the operational answer; `make scale-cpu` exists for the matrix in this section.
- **Reproducing the CPU × mixed run cleanly:** vanilla HPA defaults a 5-minute scale-down stabilization window, so switching from KEDA (which may have left the deployment at 8 pods) to CPU HPA requires bouncing the HPA (`kubectl delete hpa iocheck-cpu`, `kubectl scale deployment iocheck --replicas=2`, wait ~30s, re-apply) before running the load test. Otherwise the test starts with leftover replicas and the "flat at the floor" demonstration is muddied. This is an inconvenience of vanilla HPA's defaults, not a change to its scaling logic.
- **Schema init via ConfigMap.** `postgres-init` ConfigMap only runs on an empty PVC. Schema migrations belong in a proper migration tool the moment the schema has more than one table.
- **kube-proxy is connection-level, not request-level.** New pods added after a scale-up event only receive traffic from *new* TCP connections; long-lived keep-alive connections stay pinned to the pods that existed at connect time. The load-test scenarios cycle connections per VU iteration to compensate (see Challenge 2). In a real deployment this is solved by an L7 LB or service mesh; without one, scale-up effectiveness depends entirely on client connection-recycling behavior.


how much of this should i add to writeup.md or is it all fluff (not content just the categories)

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Comparing structures (yours vs. the pasted draft), most of the draft's extra categories are bloat for a take-home this length. Honest verdict:

**Worth lifting (2-3):**
- **Assumptions** — a short bullet list (verdict semantics, IOC lifetime, auth=none, write pattern, SLO interpretation). The brief is open-ended on these and a consolidated list is a stronger defense than burying them inline. You already have SLO interpretation; the others are scattered.
- **Production caveats** — kind port shift, `--kubelet-insecure-tls`, schema-init-only-on-empty-PVC, kube-proxy connection-stickiness. These aren't derivable from code and matter to whoever inherits this. Strong closing section.
- **"What this test reveals about RPS scaling"** — *only* if you actually ran the cache-bypass / all-miss scenario and saw the DB-saturation pathology. If you did, it's the best analytical content in the draft. If not, skip — don't invent it.

**Skip as bloat:**
- TOC — your writeup is ~300 lines, navigable already.
- **Design rationale** as a separate top-level section — duplicates what's already inline in your Architecture + Challenge sections. Splitting "forward-looking design" from "backward-looking measurement" sounds tidy but mostly produces restatement.
- **Services** table — already covered in Architecture bullets.
- **Testing strategy** as its own section — Challenge 4 already does this.
- The long citation parade (Brendan Gregg, Tinybird, Zalando, Knative, Cloudflare, Little's Law) — reads as blog-padding, not exercise deliverable. Your appendix-style citation block is the right calibration.
- **Autoscaling → "Why RPS — the pivot in plain terms"** with the restaurant analogy — interview-narrative, not document-prose.

Net: add ~Assumptions (10 lines) and ~Production caveats (15 lines). Skip the rest. Your current structure is already tighter than the draft.

## User

ok add those

## Assistant

> Bash: cat /Users/carrein/Desktop/iocheck2/kind-config.yaml 2>/dev/null; echo "---"; ls /Users/carrein/Desk...

## Assistant

> Bash: grep -rE "(30080|18080|8080|insecure-tls|kubelet-insecure)" /Users/carrein/Desktop/iocheck2/Makefile...

## Assistant

> Bash: grep -rE "(metrics-server|kubelet-insecure|kubelet.insecure)" /Users/carrein/Desktop/iocheck2/Makefi...

## Assistant

> Bash: grep -rE "(postgres-init|init.sql|ConfigMap)" /Users/carrein/Desktop/iocheck2/manifests/postgres/ 2>...

## Assistant

> Bash: grep -E "(insecure|kubelet-insecure-tls|metrics-server)" /Users/carrein/Desktop/iocheck2/manifests/m...

## Assistant

> Bash: grep -n "metrics-server\|kubelet-insecure" /Users/carrein/Desktop/iocheck2/Makefile | head -20

## Assistant

> Bash: grep -n "metrics-server" /Users/carrein/Desktop/iocheck2/scripts/*.sh /Users/carrein/Desktop/iocheck...

## Assistant

> Bash: grep -rn "kube-prometheus\|--kubelet" /Users/carrein/Desktop/iocheck2/Makefile 2>/dev/null | grep -i...

## Assistant

Adding two sections — Assumptions inside §1 (before SLO interpretation), and Production caveats between §5 and the Appendix.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Added both sections. Two notes on what I changed vs. what was in the draft:

- **Dropped the host-port-shift caveat** — `kind-config.yaml` actually maps `30080 → host 8080` (not 18080). The draft was wrong or stale.
- **Dropped the `--kubelet-insecure-tls` caveat** — there's no explicit metrics-server patch in the Makefile or manifests; kube-prometheus's bundle handles it. Not a caveat for this build.
- **Dropped the kube-proxy connection-stickiness caveat** — already covered in Challenge 2.

Replaced with three caveats grounded in what's actually in the repo: the `kube-prometheus` slimming (alertmanager + blackboxExporter stripped to fit RAM), Grafana anonymous-access override, and single-replica DB/cache posture.

## User

Can you parse the ASSUMPETIONS field in the WRITEUP.md? Are the assumptions still accurate for our system here? Did we make or gloss any new assumptions? Are there any other core assumptions to add that we miss? /carrein-uberthink

## Assistant

> Skill

## Assistant

This is an audit, not a build — no plan or build-phase needed. I'll run the research thoroughly and give you a structured response. Skipping the questioning ceremony since the audit dimensions are concrete.

Let me read the current WRITEUP.md state and verify each assumption against the actual code.

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Bash: ls /Users/carrein/Desktop/iocheck2/src/ /Users/carrein/Desktop/iocheck2/manifests/iocheck/ /Users/ca...

## Assistant

Confirmed the duplicate (lines 19-34 and 93-108 are byte-for-byte identical). Now verifying each assumption against the code.

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/src/cache.ts

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/src/lookup.ts

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/src/admin.ts

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/src/server.ts

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/src/db.ts

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/manifests/postgres/init-configmap.yaml

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/manifests/iocheck/deployment.yaml

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/loadtest/script.js

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/manifests/iocheck/service.yaml

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/manifests/iocheck/configmap.yaml

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/manifests/overlays/rps-hpa-8/scaledobject.yaml

## Assistant

> Bash: ls /Users/carrein/Desktop/iocheck2/manifests/redis/ 2>/dev/null; echo "---"; cat /Users/carrein/Desk...

## Assistant

> Bash: grep -E "PARALLELISM|parallelism|TARGET_RPS|MISS_RATE" /Users/carrein/Desktop/iocheck2/loadtest/job....

## Assistant

> Bash: grep -nE "max_connections|MAX_CONNECTIONS" /Users/carrein/Desktop/iocheck2/manifests/postgres/*.yaml...

## Assistant

Audit complete. Here's the structured response.

## Audit of `# Assumptions` in WRITEUP.md

### 1. The duplicate
Lines 19–34 (top-level `# Assumptions`) and lines 93–108 (inside §1 Architecture, `### Assumptions`) are **byte-identical**. Recommend keeping the top-level placement (it's a meta-assertion about the whole build, not architecture-specific) and deleting the §1 duplicate.

### 2. Per-assumption verdict against the code

| # | Assumption | Verdict | Notes |
|---|---|---|---|
| 1 | IOC lifetime: immortal; cache 5min / 60s | ✅ accurate | `cache.ts:14-15` (`HIT_TTL=300`, `MISS_TTL=60`); schema has no expiry column or cleanup job. |
| 2 | Write pattern: low-rate, no batch | ✅ accurate | Only `POST /ioc` single-row upsert (`server.ts:78-108`). |
| 3 | Auth posture: token on `/ioc`, `/lookup` open, **"Cluster-internal Service only"** | ⚠️ **partially wrong** | Code matches, but `service.yaml` is `type: NodePort` with `nodePort: 30080` (→ kind host 8080). The Service is exposed outside the cluster. Reword: *"Service is NodePort, surfaced on the host via kind's port-map; no Ingress, no mTLS, no host firewall."* |
| 4 | Sizing target: ~1000 RPS, ~10× burst, laptop kind | ✅ accurate as stated | But unrelated bug: §3 Challenge 1's load-profile description ("ramp 0→100 / 60s, 100→1000 / 4min, 1000→0 / 5min") **does not match** `loadtest/script.js` (0→1000 / 30s, sustain 90s, drain 30s). Fix §3, not §Assumptions. |
| 5 | Burst shape: "high cache-hit rate, hot keys dominate" | ❌ **wrong / contradicts the data** | All bench defaults run **MISS_RATE=0.8** (Makefile + script.js:39). §3 Challenge 4 reference table shows cache-hit-rate **19.7–20%**. §5's RPS argument ("workload mix is well-characterised cache-friendly") is built on a premise the benches actively refute. This is the single biggest issue. |

### 3. Glossed / missing assumptions worth adding

Real load-bearing assumptions made in the build that the writeup doesn't surface:

- **Postgres connection-pool sizing is the silent safety net.** `PG_POOL_MAX=10/pod` × 8 max replicas = 80 conns; `max_connections=200` gives 2.5× headroom. This calibration is what keeps RPS-based scaling viable under the 80% miss workload — without it, scale-out would saturate the DB pool and tail latency would explode. The earlier draft of the writeup had a "What this test reveals about RPS scaling" section that called this pathology out; it was cut but the assumption is still load-bearing.
- **Redis is ephemeral by design.** `--save ""`, `--appendonly no`, `allkeys-lru` at 256MB. Cache is reconstructible-from-Postgres only; restart = cold cache. Mentioned in Architecture, not in Assumptions.
- **Cache eviction can preempt TTL.** Under memory pressure, LRU evicts regardless of `EX`. The 5-min TTL is a ceiling on staleness, not a floor on retention.
- **Verdict semantics & score-as-metadata.** Presence ⇒ `"malicious"`; `score` is informational, not a threshold. Currently in §2 prose, but it's a real assumption — the brief leaves the verdict rule undefined.
- **Measurements are all in-cluster load.** k6 Job hits ClusterIP from inside the pod network. Calibrations (100 RPS/pod, NodePort exposure, kube-proxy connection-stickiness mitigation) apply to in-cluster traffic; external clients arriving via NodePort+host port have different stickiness behavior and the threshold may need re-tuning.
- **Bun is single-threaded.** No `worker_threads`, no cluster mode. Per-pod throughput is bounded by one event loop — this is *why* in-flight queueing is the natural saturation signal (§5).
- **Bench time scale ≠ production time scale.** Total bench is ~3 min; scale-down stabilization is 60s. Production alert storms last longer; the cooldown tuning is demo-friendly, not production-tuned.
- **IOC type set is closed.** `{ip, domain, sha256}` enforced by Postgres `CHECK` constraint. New types require schema migration.

### 4. Internal contradictions surfaced by the audit (not in Assumptions, but related)

- §3 Challenge 1 "Root cause" claims "~90% Redis hit rate" — §3 Challenge 4's own reference table says **20%**. Pick one.
- §5 ("With another week") motivates the in-flight pivot by saying RPS works "because the workload mix is well-characterised — high cache-hit rate." The actual reference numbers contradict the premise.
- §3 Challenge 1's load profile description doesn't match `loadtest/script.js`.

### Recommendation

Two changes are urgent:
1. **Delete the duplicate** (lines 93–108).
2. **Fix Assumption #5** — either retune benches to a cache-friendly mix (`MISS_RATE=0.1`) so the assumption holds, or rewrite the assumption to match reality (*"benches default to 80% miss as a stress mix; the in-flight pivot in §5 motivates exactly this case"*). The latter is cheaper and arguably stronger — the build's whole §5 argument lands harder when the data shows RPS-as-signal under load it wasn't optimized for.

Three are worth adding for completeness: **PG pool sizing**, **Redis ephemerality**, **verdict semantics**. The rest (eviction, in-cluster load, single-thread, time scale, closed type set) are nice-to-have.

Want me to apply the deletion + #5 rewrite + add the three high-value missing assumptions?

## User

yes

## Assistant

Applying the four fixes — duplicate deletion, auth posture reword, burst-shape rewrite, plus the three new assumptions (verdict semantics, cache ephemerality, PG pool calibration).

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Both edits applied. Quick verification on the diff and a final flag.

## Assistant

> Bash: git diff --stat WRITEUP.md && echo "---grep for any lingering 'Assumptions' headings---" && grep -nE...

## Assistant

Done — exactly one `Assumptions` heading remains (line 19), and the bullets are:

1. Verdict semantics *(new)*
2. IOC lifetime
3. Cache is ephemeral by design *(new)*
4. Write pattern
5. Auth posture *(NodePort wording fixed)*
6. Sizing target
7. Burst shape *(rewritten: 80% miss stress mix, motivates §5)*
8. Connection-pool calibration *(new)*

### One follow-up worth flagging

Now that Assumption #7 says benches default to 80% miss, the prose in **§3 Challenge 1 "Root cause"** ("With ~90% Redis hit rate, the average request spends nearly all its wall time waiting on Redis I/O…") is overtly contradicted by both the new assumption and §3 Challenge 4's reference table (19.7–20% hit rate). The Challenge 1 analysis still lands — the CPU-is-flat conclusion is independent of hit rate — but the prose needs a tweak so it isn't internally inconsistent. Want me to fix that next?

## User

Can you add a GOALS section right underneath it?

## Assistant

Adding a Goals section between Assumptions and Architecture.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Added. The new Goals section sits between `# Assumptions` and `# Architecture`, names the four deliverables (matching §3's challenge order), lists the two cross-cutting hard requirements (SLO + PDB), and explicitly fences off what's out of scope so the reviewer doesn't read absences as oversights.

## User

- **Verdict semantics**: presence in `iocs` ⇒ `"malicious"`, absence ⇒
  `"unknown"`. `score` is operator metadata, not a threshold — the brief leaves
  the rule undefined, so the simplest interpretation wins.
- **IOC lifetime**: immortal. No expiry on `iocs` rows; cache TTL (5 min
  positives, 60 s negatives) is a freshness/cost tradeoff, not an SLA on staleness.
- **Cache is ephemeral by design**: Redis runs `--save "" --appendonly no` with
  `allkeys-lru` at 256 MB. The cache is reconstructible from Postgres on cold
  start; restart = cold cache, and under memory pressure LRU eviction can preempt
  TTL. The 5-min positive TTL is a ceiling on staleness, not a floor on retention.
- **Write pattern**: low-rate continuous via `POST /ioc`. No batch-ingestion
  path; bulk feeds (MISP exports, AbuseIPDB dumps) would want a different code path.
- **Auth posture**: `POST /ioc` requires `X-Admin-Token`; `POST /lookup` is open.
  The Service is `NodePort` (surfaced on the kind host at `:8080` for manual
  smoke testing); no Ingress, no mTLS, no host firewall.
- **Sizing target**: ~1000 RPS sustained with ~10× burst envelope on a
  laptop-sized kind cluster. The exercise tests autoscaler _behavior_, not raw
  throughput; production sizing is its own problem.
- **Burst shape**: benches default to `MISS_RATE=0.8` — an 80% cache-miss stress
  mix, not a cache-friendly steady state. The §5 in-flight pivot is motivated by
  exactly this regime: RPS works as a signal here, but a workload mix shift
  would degrade it before in-flight would.
- **Connection-pool calibration**: `PG_POOL_MAX=10/pod` × 8 max replicas = 80
  conns vs Postgres `max_connections=200` (~2.5× headroom). This is what keeps
  RPS-as-signal viable under high-miss bursts — a tighter pool would let
  scale-out saturate the DB and turn the autoscaler into the cause of the
  pathology it's meant to defend against.

put this in a table and make it briefer man

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Done. Eight rows, one tight sentence each, same content compressed into ~10 lines instead of ~25.

## User

Are there any other assumptions or goals we might have missed? Use subagents to discover.

## Assistant

Spawning three parallel subagents — code/runtime, infrastructure, and brief-vs-delivery — to hunt from different angles.

## Assistant

> Agent: Hunt code/runtime assumptions

## Assistant

> Agent: Hunt infrastructure assumptions

## Assistant

> Agent: Hunt brief-vs-delivery gaps

## Assistant

Converting Goals to a table first.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Goals now in table form. Now the subagent findings.

## Subagent findings — assumptions/goals not yet captured

Three agents hunted independently. Synthesizing only the **high-signal** items (skipping nice-to-haves and items already implied by §1/§6).

### Goals worth adding (or arguably already implicit)

| Candidate | Source | My take |
|---|---|---|
| **Failure-mode behavior of the autoscaler** | EXERCISE.md line 100 asks explicitly "what happens when your autoscaler's data source is itself unavailable" | Already a Goal in spirit — §4 answers it. Worth promoting to a 7th row in the Goals table so the structure mirrors the brief. |
| **AI chat logs** | EXERCISE.md line 102 lists this in deliverables | The repo's `logs/` directory satisfies this (Stop-hook generated). Worth one line in Goals or a pointer to `logs/` in §6. |
| **SLO is "throughout spikes" per brief, not just steady-state** | EXERCISE.md ties p99 < 200 ms to "including during spikes" | Already flagged in §3 SLO interpretation as a *deliberate relaxation*. Fine — leave it, but the assumption table should call this out explicitly since you're choosing a weaker reading than the brief asks for. |

### Assumptions worth adding (high signal)

| Candidate | Justification |
|---|---|
| **10× burst multiple is inferred, not stated as a fixed contract.** | The brief says "bursty (alert storms = ~10× RPS spikes)" but the writeup treats 10× as a hard target. Worth one row noting the bench profile *implements* the brief's qualitative ask. |
| **Prometheus is the autoscaler's data source by choice, not by brief.** | EXERCISE.md is tool-agnostic. Picking Prometheus over (say) the metrics API or a custom adapter is a real assumption that shapes §4's whole failure-mode story. |
| **Load is generated in-cluster, not from outside.** | k6 runs as a Job hitting ClusterIP. EXERCISE.md doesn't require this; running externally would expose different stickiness behavior. Already noted in §3 Challenge 2 but not in Assumptions. |
| **`ADMIN_TOKEN` must be set or `/ioc` is permanently locked.** | `admin.ts:14-16` — `authorize()` returns false on empty token, no fallback. Operational footgun that should be stated. |
| **Cache-invalidation race window after `POST /ioc`.** | `admin.ts:8-9` — upsert then DEL. ~1-5 ms window where a concurrent `/lookup` can back-fill the stale row. Already implicitly justified ("invalidation, not write-through") in §1 but not in the table. |
| **No request body size limit.** | `server.ts:62,82` — `req.json()` buffers full body; a large POST would OOM at the 256Mi limit. Should be one row. |

### Lower-signal candidates (mention if you want exhaustive, skip otherwise)

- **Bun chosen over Node — brief says "TypeScript", not "Bun".** A lock-in choice, but you defend it inline in §1; adding to Assumptions would be redundant.
- **PVC storage class assumes kind's local-path-provisioner.** True. Vanilla k8s would need an explicit provisioner. Belongs in §6 production caveats, not Assumptions.
- **Image distribution via `kind load docker-image` (no registry).** Already implicit in Makefile and noted in §6 caveat material; not core enough.
- **Redis client `enableOfflineQueue: true` + `autoReconnect: true`** silently queues commands during Redis outage, masking failure for ~5s. Real, but operational nuance — fits §6 better than Assumptions.
- **`/readyz` 1-second cache** hides up-to-1s of stale readiness state. Documented inline in §2; not a missing assumption.
- **`SHUTDOWN_GRACE_MS=5s` vs `terminationGracePeriodSeconds: 30s`.** The 5s is the kube-proxy de-register window; the 30s is the kill ceiling. Both intentional, both documented in code comments; not a missing assumption.

### Recommended action

Two concrete additions if you want to act on this:

1. **Add a 7th Goal row**: "Behavior when the autoscaler's data source is unavailable — fallback documented and measured (§4)."
2. **Add 2-3 high-signal Assumption rows**: 10× burst is qualitative not contractual; Prometheus is a chosen data source; load is in-cluster. The race-window / token-required / body-size items are real but operational — probably better as a separate "Operational footguns" subsection if you want them captured.

Want me to apply these?

## User

Apply

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Applied. Goals table now has 7 rows (added the data-source failure-mode deliverable). Assumptions table now has 10 rows — the Sizing target row was edited to acknowledge the 10× burst is an interpretation, and two new rows added: Autoscaler data source (Prometheus is a chosen pick, not brief-mandated) and Load origin (in-cluster k6, not external).

## User

Add two sections after API. 1. List the resources we have and the limits/budgets we have for those and explain why i.e. Redis 500m. 2. List the load testing suites we have and the curve they follow and why.

## Assistant

Let me gather the resource specs for Postgres, Redis, and the k6 Job first.

## Assistant

> Bash: grep -A 8 "resources:" /Users/carrein/Desktop/iocheck2/manifests/postgres/statefulset.yaml /Users/ca...

## Assistant

> Bash: grep -nE "^_bench:|OBSERVATION|POLL_INTERVAL|BENCH_OBSERVE|observation" /Users/carrein/Desktop/ioche...

## Assistant

> Bash: grep -B 1 -A 12 "resources:" /Users/carrein/Desktop/iocheck2/manifests/redis/deployment.yaml

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/loadtest/script.js

## Assistant

> Bash: grep -nE "^#+ " /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

I have everything I need. Two new sections to insert after §2 (API), then renumber the existing §3-§6 to §5-§8 and update the cross-references.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Now renumbering the rest of the headers and fixing cross-references.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Now the cross-references in body text — I'll find them all and update.

## Assistant

> Bash: grep -nE "§[0-9]" /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Final sanity check on the section numbering and refs.

## Assistant

> Bash: grep -nE "^##? [0-9]" /Users/carrein/Desktop/iocheck2/WRITEUP.md; echo "---cross-refs---"; grep -nE ...

## Assistant

Clean. Numbering runs §2 → §3 → §4 → §5 → §6 → §7 → §8 with no gaps; every cross-reference points at the new target. Summary:

- **§3 Resources & budgets** — 7-row table (iocheck, postgres, redis, k6, prometheus, grafana, KEDA) with replicas, req/limit, and the why behind each floor. Postgres-CPU and Redis-CPU rationales come straight from the empirical "starvation at 200m/50m" notes in the manifests. Footer captures the cluster-wide budget math and the PVC/persistence posture.
- **§4 Load testing suites** — bench-target table (cpu / rps4 / rps8 / failure / all), shared load-curve table (30 s ramp / 90 s sustain / 30 s drain / 120 s observe), plus five "why" paragraphs covering phase widths, open-model executor, MISS_RATE default, k6 parallelism, and the `noConnectionReuse` rationale.

## User

For arhcitecutre:

guage / framework: TypeScript on Bun 1.3, using Bun.serve directly (no router framework). Bun was specified by the brief's "TypeScript" line and the user's "lean on Bun's std lib" guidance — TS, HTTP, SQL, Redis, and a test runner all ship in one toolchain, making the dev/CI/image story tighter.
Persistent store: Postgres 17 (Alpine, StatefulSet, one replica, 2 GiB PVC). Composite primary key (type, value) matches the exercise's lookup pattern exactly; ON CONFLICT … DO UPDATE gives a one-statement upsert. Considered Redis-only and DynamoDB-style KV: relational won because lookups are keyed on a tuple and the schema check constraints (score 0–100, type IN ('ip','domain','sha256')) carry their weight.
Cache: Redis 7.4, single Deployment, --maxmemory 256mb --maxmemory-policy allkeys-lru --save "". Read-through; on cache miss the service consults Postgres and back-fills. On POST /ioc we DEL the key — invalidation, not write-through, because the cache also holds short-lived negative tombstones (unknown values cached for 60 s, hot positives 5 min), and these need to be flushed too. Ephemeral by design: the cache is reconstructible from Postgres on cold start.
Cluster: kind 0.31 with 1 control-plane + 3 worker nodes, kindest/node:v1.32.0. Multi-node is load-bearing: pod anti-affinity spreads iocheck replicas across workers, so kube-proxy round-robins ClusterIP traffic across nodes (Challenge #2). Single-node kind hides the cross-node split and makes "pods share load" trivially true.
Autoscaling signal: cluster-total RPS via Prometheus, divided by replica count inside HPA (KEDA metricType: AverageValue), target 100 RPS/pod. Rationale below.

modify this toa  table with all the services tools used in the architecture diagram and why we picked those

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Architecture bullets replaced with an 8-row table covering every node in the mermaid diagram plus the service runtime, with one-line rationale per pick. The autoscaling-signal headline is preserved as a one-liner after the table, pointing at §5 for the detailed justification.

## User

7. With another week

Feels kinda lean: my own take is if i had more time i would try other metrics i.e. inflight (Not REPLACE) and mixed metrics i.e. p99 + something else or some biz metrics to see what works best. What are some other future improvements that we can see with this (could be a mix or testing/system and product i.e. dashboard

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Handling both — expanding §7 and dropping §8. Will also clean up the few §8 cross-references that point at the deleted section.

First, the expanded §7:

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Now deleting §8 entirely.

## Assistant

> Bash: grep -nE "^## 8\.|^## Appendix" /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Now fixing the cross-references that pointed at the deleted §8.

## Assistant

> Bash: grep -nE "§8" /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Final sanity check.

## Assistant

> Bash: grep -nE "^##? [0-9]|§[0-9]" /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Clean. Sections now run §2 → §3 → §4 → §5 → §6 → §7 (and Appendix). No dangling §8 references.

Summary of what changed:

- **§7 expanded** from a single in-flight-replaces-RPS pitch into four sub-sections — Scaling signals (in-flight, composite p99-OR-RPS, business-aware triggers, bake-off harness), Tests & observability (soak, chaos, regression tracking, external traffic), System (pgbouncer, read replicas, Redis HA, L7 LB/mesh, auth, rate limiting), Product (analyst UI, operator dashboard, batch ingestion, IOC lifecycle, bulk lookup, webhooks). The framing is now additive ("alongside RPS") not replacement, per your note.
- **§8 deleted** entirely. The two items inside it that were load-bearing (kube-prometheus slimming rationale, Grafana anonymous-Admin caveat) were inlined into the §3 Resources rows where they belong, so no information is actually lost. The other three §8 items (schema-init, single-replica HA, CPU-HPA-is-illustrative) are already covered elsewhere — schema-init is implicit in §1, HA in §7 system, and CPU-HPA-illustrative in §5 Challenge 1.
- **Cross-references** to §8 updated in the Goals out-of-scope line and the two Resources rows.

## User

I think we can drop this ## Appendix — citations


I want add to  somewhere very clear about picking RPS with our core reasoning being a) using prior precedence with LINSK looking for precedents (Knative concurrency, Zalando's autoscaler) and b) our workload i.e. stateless is a natural fit or soemthing.

Explain why CPU-based HPA is wrong for this workload. Measured evidence, not theory.


this is of course theory but we support with evidence after right?

## Assistant

Two edits — add a "Why RPS" subsection at the prominent spot (replacing the one-liner after the architecture table), and delete the Appendix.

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Now dropping the Appendix.

## Assistant

> Bash: grep -nE "^## Appendix" /Users/carrein/Desktop/iocheck2/WRITEUP.md && wc -l /Users/carrein/Desktop/i...

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Both done. On your theory-vs-evidence question:

**Yes, that framing is correct and is exactly how the writeup is structured now.** The brief's Challenge 1 asks for "measured evidence, not theory" — meaning the *conclusion* about CPU must rest on data, not assertion. It doesn't forbid you from stating a hypothesis up front and validating it afterward. In fact, that's the right structure for any engineering writeup:

- **§1 Architecture / "Why RPS"** — hypothesis: workload-shape argument (stateless, cache-fronted, Zalando precedent) + structural dismissal of CPU (cache I/O wait doesn't scale with arrival rate).
- **§5 Challenge 1** — measurement: CPU peaks at ~20% of request at 956 RPS, 3.5× below the 70% trigger. Hypothesis confirmed empirically.

The brief is satisfied because the *answer* to "why is CPU wrong" is grounded in numbers from `artifacts/`. Your reasoning ("prior precedence + workload fit") is the *motivation* for picking the experiment, not a substitute for it. Two different jobs, both belong in the doc, and they now sit cleanly in two different sections.

The new "Why RPS" subsection makes this explicit with the phrase "Everything above is **hypothesis**… empirical validation is in §5 Challenge 1" — so a reviewer can't accuse the writeup of conflating the two.

## User

Right i wanna frame it like u got to start somewhere so i used AI to find precedence and then use that as a default for testing

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Reframed. The lead paragraph now names the workflow explicitly — "AI-assisted research → precedent → default → benchmark" — instead of presenting RPS as if it fell out of a derivation. Two consequences:

- The Knative + Zalando bullets are positioned as *the precedents the research surfaced*, not as a tradeoff analysis we authored from scratch. Honest about how the work was done.
- "RPS becomes the default benchmark" is the load-bearing phrase: it ties §5 Challenge 1 (CPU benched against the default) and §7 (in-flight benched against the default) back to a single procedural decision instead of treating them as separate questions.

## User

For the Architecture section: Component    Pick    Why

make this terser.

In general for the whole document, don't need to mention versioning or language

## Assistant

> Bash: grep -nE "([0-9]+\.[0-9]+|TypeScript|TS,|v1\.|v2\.|v0\.|≥[0-9])" /Users/carrein/Desktop/iocheck2/WRI...

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Three edits to batch: tighter Architecture table, API as table, plus the version cleanups across the doc.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Now the API table.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Now the remaining version mentions across the doc.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Bash: grep -nE "Bun [0-9]|Postgres [0-9]|Redis [0-9]|kind [0-9]|KEDA [0-9]|k6 [0-9]|v[0-9]+\.[0-9]+|2\.1[7...

## Assistant

Clean — no stray version numbers or language references left. Summary of the four edits:

- **Architecture table** — dropped versions (`Bun 1.3`, `Postgres 17`, `Redis 7.4`, `kind 0.31`, `kindest/node:v1.32.0`, `kube-prometheus v0.17.0`, `KEDA 2.19`, `k6 1.3`), removed the redundant TypeScript framing in the runtime row, and trimmed cell content where §3 Resources already covers the operational specifics (PVC size, maxmemory). Why-column reasoning kept intact.
- **API section** — converted to a 5-row table with `Route | Method | Auth | Behavior` columns. Verdict-rule intro kept as one prose sentence above the table.
- **§3 Resources / KEDA row** — dropped the `2.19.0 / ≥2.17` pin; kept the feature-dependency note.
- **§5 Challenge 4** — dropped the `grafana/k6:1.3.0` image tag.
- **§6 Failure mode** — dropped the `Requires KEDA ≥ 2.17` trailing sentence.

## User

can u add this to table as Out of scope and maybe with - for the # Out of scope: raw throughput records, production-grade HA on dependencies (single-replica Postgres + Redis), ingress / auth hardening, batch ingestion. Flagged in §7 (with another week)

## Assistant

> Bash: grep -n "Out of scope\|^| [0-9-] |" /Users/carrein/Desktop/iocheck2/WRITEUP.md | head -15

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Folded the four out-of-scope items into the Goals table as their own rows (with `-` in the # column and `Out of scope` as the type), and left one trailing prose line pointing at §7 for the "what we'd do with more time" cross-reference.

## User

We already have: 3. Resources & budgets section. Do we need to describe k6 (in-cluster Job, parallelism: 4) and kind (1 control-plane + 3 workers) in such details for the architecture?

## Assistant

You're right — those are deployment details that §3 already owns. The Architecture table should describe *what we use and why we picked it*, not *how we configured it*. Same redundancy is in the Postgres and Redis rows too.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Done. Pick column is now just *what we use*; deployment specifics (replicas, parallelism, node counts) live in §3 Resources & budgets. The architectural-relationship parentheticals stay where they were doing real work:

- `Bun (Bun.serve directly, no router)` — keeps the design-choice signal (no framework)
- `Prometheus (via kube-prometheus)` — keeps the install-mechanism signal
- `KEDA (drives a generated HPA)` — keeps the controller-relationship signal

## User

Make the Why of Architecture less verbose. Example instead of: 

Ships HTTP, SQL, Redis client, and test runner in one toolchain — no node_modules build step, no framework lock-in.

Fast runtime client that bundles a, b, c in it etc

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Each Why is now one short sentence in the same elevator-pitch style as your example. Substantive bits that were doing real work moved or already covered elsewhere:

- **Bun**: "Fast TS-native runtime that bundles HTTP, SQL, Redis client, and a test runner."
- **Postgres**: "Composite-key relational lookup with schema-side CHECK constraints; beat Redis-only / KV on key shape and validation."
- **Redis**: "Read-through with negative tombstones; PG is the source of truth, cache reconstructible on cold start."
- **kind**: "Multi-node enables pod anti-affinity → real load distribution across workers (Challenge #2)."
- **Prometheus**: "Industry-default TSDB and KEDA's most-supported scaler input."
- **Grafana**: "Bundled with kube-prometheus; anonymous Admin for demo only."
- **KEDA**: "Plugs Prometheus into a managed HPA — non-CPU triggers + fallback behavior (§6)."
- **k6**: "Open-model `ramping-arrival-rate` executor — RPS is a fixed input, not gated by service throughput. See §4."

The double-division footgun and the SOC-tombstone-TTL detail still exist in §5 Challenge 3 and the Assumptions table respectively, so nothing load-bearing was lost.

## User

With another week

WAY too verbose. Pare it down greatly into 5 core points. My selection:

1.Sccaling singlas eplxore i.e. composite triggers inflight etc

2. pick 1 from tests & observability
3. add pgbouncer 
4. adshboard
5. ur hoice

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Pared to 5 numbered points, each a single tight paragraph. Picks:

- **#2** → **Chaos tests** (over soak / regression tracking / external traffic). It's the natural follow-on to `bench-failure` and validates the rest of the failure-mode documentation in code comments.
- **#5** → **IOC lifecycle** (over L7 mesh / batch ingestion / auth hardening). Hooks directly into the "IOC lifetime: immortal" row in your Assumptions table, and it's the most honest "what's missing for an actual SOC" answer — distinct from the system-y picks at #1 and #3.

## User

6. Failure mode — autoscaler data source unavailable
Scenario: Prometheus goes down mid-burst. KEDA polls Prometheus every 15 s; after fallback.failureThreshold: 3 consecutive failures (~45 s), it pins the HPA target to fallback.replicas: 4 with behavior: static.

HPA behavior without fallback: the HPA would report ScalingActive=False with reason FailedGetExternalMetric and freeze at current replicas — either over- or under-provisioned indefinitely.

Service impact during the outage: zero. The data plane (iocheck pods, Postgres, Redis) is independent of Prometheus. Only the control plane (HPA) is affected.

Mitigation in place:

KEDA fallback.replicas: 4 — mid-load floor. Neither starves at min nor thunders to max. Configured in manifests/overlays/rps-hpa-8/scaledobject.yaml (and the equivalent replicas: 3 in rps-hpa-4/).
behavior: currentReplicasIfHigher — holds the current replica count if it's already above the fallback floor, otherwise lifts to 4. Beats static, which would down-scale us to 4 even if we were already at 8 mid-burst — the worst possible moment to lose pods. Matches KEDA's and Kedify's production recommendation.
The PDB (minAvailable: 2) ensures the fallback never violates the floor.
Reproduction: now reproducible via make bench-failure — applies the rps-hpa-8 overlay, patches prometheus k8s to replicas=0 at T+75s for 90s, then restores. The capture script tracks the KEDA-HPA's ScalingActive condition across the window and renders a dedicated "Fallback behavior" section in summary.md showing the replica trajectory across the blackout.

With more time: a secondary CPU-based HPA as a floor (compound HPA pattern) so sustained load still scales when Prometheus is gone, plus alerts on up{job="prometheus"} == 0 and KEDA controller error events.

Pare Failure mode. You can look at make bench-failure for what we conduct.

## Assistant

> Bash: grep -nE "bench-failure|BLACKOUT|prometheus.*replicas|fallback" /Users/carrein/Desktop/iocheck2/Make...

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Pared from ~33 lines to ~12. What survived:

- **Default behavior** (HPA freezes) and **service impact** (data plane unaffected) — collapsed into one opening sentence.
- **The two config knobs** that actually do the work — `fallback.replicas: 4` and `behavior: currentReplicasIfHigher`, with the one-line justification for why we pick `currentReplicasIfHigher` over `static`.
- **PDB invariant** — one sentence.
- **The empirical bit** — what `make bench-failure` does, what it captures.

What got dropped:

- The `fallback.failureThreshold: 3` × 15 s = 45 s math (operational detail, not in the answer the brief asks for).
- The HPA reason-string (`FailedGetExternalMetric`) — implementation noise.
- The manifest file paths and the rps-hpa-4 fallback variant — discoverable from the repo.
- "Matches KEDA's and Kedify's production recommendation" — appeal-to-authority that the configuration choice already justifies on its merits.
- The "With more time" sentence — duplicated §7's scope; §7 is where future work lives.

## User

can you make this briefer:

Why RPS as the scaling signal
Picking a scaling signal blind is a coin flip — you have to start somewhere defensible. The workflow: AI-assisted research to surface published precedent, pick the one that best matches the workload shape, make it the default, then benchmark alternatives against it.

Two precedents stand:

Concurrency / in-flight — Knative KPA. Best when per-request cost is uniform (serverless functions where every invocation looks roughly the same).
RPS — Zalando's kube-metrics-adapter. Built for hundreds of cache-fronted HTTP services at very high RPS, explicitly because "CPU/memory don't correlate linearly with throughput."
iocheck is a stateless, cache-fronted HTTP read-mostly service — Zalando's shape, not Knative's. RPS is also the most operationally legible signal: every dashboard, load-test tool, and on-call instinct already speaks RPS. RPS becomes the default benchmark; CPU is the wrong-answer comparison (§5 Challenge 1), in-flight is the next-step extension (§7).

Target: 100 RPS per pod (metricType: AverageValue); calibration in §5 Challenge 3. CPU is dismissed structurally — per-request CPU on a cache-fronted Bun service is dominated by JSON parse + Redis I/O wait, which doesn't scale with arrival rate the way HPA's utilization target assumes — and §5 Challenge 1 confirms it empirically.

SLO interpretation
p99 < 200 ms is read as post-stabilization steady state, not strict throughout the test. Scale-up takes ~60–90 s; during that window the in-flight queue drains and p99 spikes briefly. We measure success as p99 holding under 200 ms once the HPA settles, plus zero error rate. In practice on this calibration, both scenarios held p99 < 20 ms — the bottleneck during my measurements was the autoscaler signal, not the service.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Roughly halved. What survived in **Why RPS**:

- Workflow framing ("defensible default; AI surfaced two precedents") — kept because that's the *honest* description of how the choice was made.
- The two precedent bullets, one tight line each.
- One sentence each for: workload-shape match, RPS-as-default, target value with §5 pointer, and CPU's structural dismissal.

What got cut: the coin-flip metaphor, the Zalando quote, the long "every dashboard, load-test tool, and on-call instinct" expansion, the parenthetical full-sentence reasoning for the CPU dismissal.

**SLO interpretation** compressed to three sentences — same load-bearing claims (200ms is post-stabilization; scale-up spikes are tolerated; the 20ms measured floor sets up §7's framing that the autoscaler is the actual bottleneck).

## User

Remove any form of reference like these: (see §6)

## Assistant

> Bash: grep -nE "§[0-9]" /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Bash: grep -nE "§[0-9]|see §|in §" /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

All §-references cleared. Where the cross-ref was just a pointer, dropped it; where the surrounding sentence relied on the reference for meaning, paraphrased to a descriptive label (e.g. "in the future-work section", "the wrong-signal demonstration").

## User

Fix all formatting. Also replace all emdashes. Opt for either rewritting with a comma or colon.

## Assistant

> Bash: grep -c "—" /Users/carrein/Desktop/iocheck2/WRITEUP.md; echo "---lines with emdash---"; grep -nE "—"...

## Assistant

Let me also check formatting issues so I can fix both in one pass.

## Assistant

> Bash: grep -cnE "_[a-zA-Z]" /Users/carrein/Desktop/iocheck2/WRITEUP.md; echo "---inconsistent italic style...

## Assistant

Given 51 em-dashes spread across the file, I'll read the full file, apply replacements consistently, and write it back in one pass.

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Writing the full file with em-dashes replaced (colon for definition/apposition, comma for asides), table-cell `—` placeholders changed to `-`, and two typos fixed along the way.

## Assistant

> Write: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Bash: grep -cE "—" /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

All em-dashes gone. Now the Why column in §3.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Done. Two passes completed:

**Em-dash + formatting sweep.** All 51 em-dashes replaced:
- Apposition / definition patterns (`X — Y where Y defines X`) → colon: `Bun service is dominated by JSON parse + Redis I/O wait` → `dismissed structurally: per-request CPU on a cache-fronted Bun service...`
- Aside / interjection patterns (`X — context — Y`) → commas: `On a heavier workload, colder cache, slower downstream, the bottleneck...`
- Section subtitles (`Challenge 1 — Why...`) → colon: `Challenge 1: Why CPU-based HPA is wrong`
- Table-cell em-dash placeholders (`| — |`) → hyphen (`| - |`)
- Two typos fixed along the way: "an iterate fast" → "and iterate fast"; "open decision" → "open decisions"

**§3 Resources & budgets Why column.** Same tight one-sentence treatment as the Architecture table:
- iocheck: collapsed two sentences into the headline ("the wrong-signal demonstration")
- postgres: kept the empirical 200m/2400m specifics in one sentence; dropped the no-limit reasoning and shared_buffers note (already in the comment-laden manifest)
- redis: kept the 50m → slowlog observation that justifies the 500m floor; trimmed the descheduling lecture
- k6: dropped the per-pod RPS arithmetic and the kube-proxy-hashing rationale (covered in §4)
- prometheus / grafana / KEDA: each now one phrase

## User

Added a grafana.png to the root. Use this in Writeup.md somewhere.

## Assistant

> Bash: ls -la /Users/carrein/Desktop/iocheck2/grafana.png 2>/dev/null; file /Users/carrein/Desktop/iocheck2...

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/grafana.png

## Assistant

Best placement is the top of §5 — the dashboard's six panels (Replica count, RPS/pod, Latency, CPU%, In-flight, Cache hit rate) map exactly to the metrics each Challenge discusses.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Dashboard image placed at the top of §5 with a single context line mapping the six panels back to the metrics each Challenge discusses. The image renders inline in any markdown viewer (GitHub, VSCode preview, etc.) since `grafana.png` sits at the repo root next to `WRITEUP.md`.

## User

The whole document has a lot of terminology i.e. kube-proxy iptables mode load-balances at TCP-connect time.

Can we make it little more layman but not completely lose the plot

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Hitting the worst jargon-stacks: Challenge 2 mechanism + connection-stickiness (the user's literal example), Challenge 1 event-loop framing, the noConnectionReuse rationale, and the KEDA double-division gotcha. Keeping proper nouns (kube-proxy, KEDA, HPA, etc.) but glossing them inline so a reader who hasn't seen the term still follows the argument.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Five rewrites, all targeting the densest jargon-stacks. Summary of what changed:

- **Challenge 2 mechanism** — your literal example. "kube-proxy in iptables mode round-robins TCP connections" became "Kubernetes' default in-cluster router (kube-proxy) picks a backend pod every time a new TCP connection opens." The term `kube-proxy` is still named but glossed inline so a reader who hasn't met it can still follow.
- **Challenge 2 stickiness gotcha** — dropped "kube-proxy iptables mode balances at TCP-connect time" in favour of "If you reuse TCP connections (HTTP/1.1 keep-alive, the default in most clients), every request on that connection sticks to the pod it first hit." Same fact, but explains *why* before naming the mechanism.
- **§4 `noConnectionReuse`** — same softening, plus a clearer "in production the equivalent" framing.
- **Challenge 1 root cause** — replaced "event-loop concurrency / loop's comfortable working set" with the plainer "concurrency, not raw compute: Bun handles requests on a single thread, so once too many requests are in flight at once they pile up in a queue." Same content; lower entry cost.
- **Challenge 3 KEDA footgun** — replaced "HPA divides the cluster value by replica count internally, which is KEDA's most-common footgun: pre-dividing in PromQL causes double-division" with a sequenced explanation: query returns cluster-wide, HPA divides, common mistake is dividing twice.

Proper nouns kept where they're the system being described (KEDA, HPA, Prometheus, Bun, Redis, k6). Loose `internalTrafficPolicy: Cluster (default)` and `preferredDuringScheduling` annotations dropped since they were footnotes, not load-bearing.

## User

CAn you add a extermely short section at the end about lessons learnt? i.e.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Three tight bullets, each a lesson that's a step removed from the writeup's findings — methodology, system insight, harness reality — rather than restatements of "CPU is wrong" or "RPS works." Section is §8 and lives after the future-work list.

## User

maybe i just want to higlight this one point only: Most "weird" bench results came from the harness, not the system. macOS loopback caps, kube-proxy connection stickiness, kind scheduler starvation at low CPU limits — the bench infrastructure has its own physics worth budgeting time for.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/WRITEUP.md

## Assistant

Trimmed to just that lesson, dropped the bullet structure (one item reads better as a paragraph), and converted the trailing em-dash to a colon to keep the doc consistent.
