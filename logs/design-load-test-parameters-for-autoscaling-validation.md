# Session: Design load test parameters for autoscaling validation

> **Archived summary.** This was a multi-day implementation session (~2,150
> lines of raw transcript) covering the initial uberthink plan for
> `EXERCISE.md`, full Phase A–J build, end-to-end verification, and a
> closing CLAUDE.md sync. The transcript was archived for brevity; the
> durable decisions live in `.claude/plans/iocheck-plan.md` (full design
> record) and `.claude/plans/iocheck-research.md` (frozen reference notes).
> Below is a compact record of what was designed and what landed.

## What was designed

- **Service core (Bun + TS)** — Bun.serve with `routes`, Bun.sql + Bun.redis
  for storage, prom-client for metrics (hand-picked — no
  `collectDefaultMetrics()` on Bun), hand-wired SIGTERM drain pattern
  (readyz=false → sleep → server.stop → close pools).
- **Calibrated values** — 300m CPU / 128Mi mem requests, 1000m / 256Mi
  limits; min=2 / max=10 replicas (later refined per overlay); CPU threshold
  70%; RPS threshold 100/pod; PG_POOL_MAX=10; cache TTL 5 min hits / 60s
  miss tombstones; 10,000 seeded IOCs (~100 hot keys).
- **Stack pins** — Bun 1.3-slim, Postgres 17, Redis 7.4, kind v0.31.0,
  Kubernetes 1.32, KEDA 2.19, kube-prometheus v0.17.0, k6 v2.0.0,
  prom-client ^15.1.2.
- **Two KEDA overlays at this stage** — `cpu-hpa` (the "bad" autoscaler
  from EXERCISE.md) and `rps-hpa` (custom RPS metric). Both with
  `fallback.replicas: 4` for the Prometheus-down case.

## What landed

- Full implementation Phases A–J built and verified end-to-end on a fresh
  cluster: `make up` ~6 min, two benches ran the full profile, all probes
  green, KEDA scaled 2 → 9 → 3, p99 stayed under SLO.
- CPU calibration measured: ~0.12 ms/hit (lower than estimated 0.3 ms).
  At 478 RPS/pod, peak CPU is 20% of request — well under the 70% HPA
  threshold. "Wrong signal" narrative confirmed.

## Key Phase J fixes that were discovered the hard way

- **KEDA download URL** — wrong `v` placement in the original Makefile.
- **Prometheus CR patch must be `kubectl patch --type=merge`** —
  `apply -f` clobbers `podMetadata.labels` (last-applied-config replaces
  the entire spec), the operator then can't populate the Service
  selector, and the Service ends up with zero endpoints.
- **ServiceMonitor namespace selector must be `{}`** — a
  label-restricted version excluded the `monitoring` namespace itself and
  silently broke kubelet/cadvisor scraping (and therefore CPU-based HPA).
- **Prometheus NetworkPolicy patched** to allow KEDA + the loadtest
  namespace ingress (upstream kube-prometheus only allows Grafana +
  adapter).
- **prometheus-operator rollout restart** needed after iocheck namespace
  creation — the operator caches the namespace list and won't generate a
  scrape job for our ServiceMonitor without a forced re-sync.
- **Seed Job env-var order** — `$(PGPASSWORD)` substitution in
  `DATABASE_URL` requires PGPASSWORD declared *before* DATABASE_URL in
  the env list; k8s only substitutes from prior entries.
- **kind `extraPortMappings` for unused Prometheus/Grafana NodePorts
  shadowed `kubectl port-forward` binds** — Docker binds the host port
  the moment the container starts even without a matching Service.
  Removed those mappings; access goes via Makefile port-forwards.
- **Makefile inline `# comment` inside the bench heredoc swallowed the
  rest of the recipe** — make joins recipe lines into one shell string
  before the shell sees them. Inline comments removed.

## Closing sync

CLAUDE.md was rewritten from a generic Claude-Code template to a real
project guide describing the now-built service. Memory was updated to
replace the predicted "p99 walls" narrative with the measured "CPU never
moves" narrative. Breadcrumb written to `.claude/audit-marker`.
