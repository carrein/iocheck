# iocheck

A small threat-intel lookup service built for the take-home in [`EXERCISE.md`](./EXERCISE.md).
Design discussion in [`WRITEUP.md`](./WRITEUP.md); AI session transcripts in [`logs/`](./logs/).

## Quickstart

**Host requirements:** Docker (≥ 24), `git`, `make`, `bash`, `curl`.
That's it — `kind` and `kubectl` get downloaded into `./.bin/` by `make up`.

```bash
git clone <repo> && cd iocheck
make up              # ~5–6 min: cluster + KEDA + Prometheus + service + seed
make bench-cpu       # CPU-HPA scenario              →  artifacts/cpu-hpa-<mode>-<ts>/
make bench-rps4      # RPS-HPA, max=4 (tight)        →  artifacts/rps-hpa-4-<mode>-<ts>/
make bench-rps8      # RPS-HPA, max=8                →  artifacts/rps-hpa-8-<mode>-<ts>/
make bench-failure   # Prometheus blackout (writeup §4) → artifacts/failure-<mode>-<ts>/
make bench-all       # runs cpu + rps4 + rps8 → artifacts/bench-all-<ts>/comparison.md
make down            # destroys cluster, removes .bin/
```

All bench targets default to the same workload — `TARGET_RPS=1000`,
`MISS_RATE=0.8` (80% cache-miss / 20% hot) — so results are directly
comparable across the autoscaler configurations. Override per run:
`make bench-rps8 MISS_RATE=0.1` for a hot-mix probe, or `MISS_RATE=1`
for an all-miss DB-saturation probe.

Once `make up` finishes, Grafana is reachable at <http://localhost:3000> with
anonymous access — it lands directly on the iocheck dashboard, no login needed.
The Grafana port-forward is (re)started at the top of each `bench-*` run. A
`summary.md` is printed to stdout when each bench finishes and also saved under
`artifacts/<scenario>-<timestamp>/` alongside the raw trajectories.

## What gets built

- **Service** (Bun + TypeScript) on `Bun.serve` with `Bun.sql` (Postgres) and
  `Bun.redis` (Redis). Read-through cache, invalidate-on-upsert, Prometheus
  exposition on `/metrics`.
- **Cluster** (kind, 1 control-plane + 3 workers, K8s v1.32) with pod
  anti-affinity spreading replicas across workers.
- **Autoscaling** via KEDA `ScaledObject`s — three wired overlays plus one
  unwired future-work overlay:
  - `cpu-hpa`: CPU at 70% of request (the "wrong" signal from the brief)
  - `rps-hpa-4`: cluster RPS / replicas = 100 RPS-per-pod, max=4 (tight)
  - `rps-hpa-8`: same trigger, max=8 (moderate)
  - `inflight-hpa`: in-flight requests per pod = 20 — future-work
    hypothesis from WRITEUP §5; the overlay is present so it can be benched
    without rebuilding, but is not wired to a Makefile target.

  The horizontal overlays carry `fallback.replicas` + `behavior:
  currentReplicasIfHigher` for Prometheus-down resilience — tested
  end-to-end by `bench-failure` which patches Prometheus to replicas=0
  mid-bench and checks that the HPA's replica count stays steady.
- **Observability**: kube-prometheus (Prometheus + Grafana + node-exporter +
  kube-state-metrics + prometheus-adapter). Custom dashboard
  `dashboards/iocheck.json` imported automatically at `make up`.
- **Load**: k6 (`grafana/k6:1.3.0`) as an in-cluster Job (4 parallel pods,
  `noConnectionReuse: true` so kube-proxy load-balances per-request),
  `ramping-arrival-rate` open-model executor: 30s ramp → 90s @ 1000 RPS →
  30s drain → 2 min post-k6 observation for scale-down capture.
  Pushes metrics to Prometheus via remote-write.

## API (per [`EXERCISE.md`](./EXERCISE.md))

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/lookup`  | `{type, value}` → `{verdict, ioc?}` |
| `POST` | `/ioc`     | upsert `{type, value, source, score}` — requires `X-Admin-Token` header |
| `GET`  | `/healthz` | liveness (always 200 while process is up) |
| `GET`  | `/readyz`  | 200 only when DB + Redis are reachable |
| `GET`  | `/metrics` | Prometheus exposition |

`verdict` rule: a row in `iocs` ⇒ `"malicious"`; otherwise `"unknown"`. Score is
returned as metadata, not used as a threshold.

```bash
# from inside the cluster (or via NodePort 30080 → host 8080):
curl -X POST http://localhost:8080/lookup \
  -H 'content-type: application/json' \
  -d '{"type":"ip","value":"10.0.0.0"}'
# → {"verdict":"malicious","ioc":{"type":"ip","value":"10.0.0.0","source":"internal-soc","score":50,"added_at":"..."}}
```

## What the demo looks like

Four bench targets against the same workload (80% miss / 20% hot @ 1000 RPS)
isolate the autoscaling shape (or its absence) as the only variable:

1. **`make bench-cpu`** — pods stay at 2 (CPU never crosses 70% threshold
   even under DB-saturating load). Demonstrates Challenge 1: CPU is the
   wrong signal for an I/O-bound workload.
2. **`make bench-rps4`** / **`bench-rps8`** — KEDA reads
   `sum(rate(http_requests_total[1m]))` from Prometheus, scales replicas
   from 2 toward the per-scenario ceiling within ~60 s of burst, then drains
   back to 2 after k6 ends. Tight (max=4) vs moderate (max=8) ceilings let
   you see how the ceiling shapes the latency profile.
3. **`make bench-failure`** — same rps-hpa-8 overlay, with the Prometheus
   StatefulSet patched to `replicas=0` at T+75s for 90s. Tests writeup §4's
   fallback claim: `fallback.replicas` + `behavior: currentReplicasIfHigher`
   should hold the HPA target steady while the metric source is dark.
4. **`make bench-all`** — runs cpu + rps4 + rps8 sequentially (~15 min wall
   clock) and emits `artifacts/bench-all-<ts>/comparison.md` — a single
   side-by-side table of p99, error rate, peak replicas and SLO checks
   across the three autoscaler configs. Failures of any one sub-bench are
   non-fatal — the row is flagged and the run continues.

Each bench drops a markdown summary into `artifacts/`:
```
artifacts/rps-hpa-8-miss80-20260513T1442Z/
  summary.md                  ← human-readable, also printed to stdout
  k6-stdout.txt               ← full k6 output
  replica-trajectory.csv      ← pod count sampled every 5 s
  prometheus-snapshots.json   ← PromQL series for the test window
  hpa-events.txt              ← kubectl describe hpa
```

## Local dev (optional)

Skip the cluster, iterate on the service alone. Compose maps Postgres to host
`:55432` and Redis to `:56379` so the dev stack never collides with whatever
else is on the default ports.

```bash
docker compose up -d            # postgres on :55432, redis on :56379
ADMIN_TOKEN=dev bun run dev     # fallbacks already point at the compose ports
```

`bun test` brings the compose backends up automatically (`docker compose up -d
postgres redis --wait && bun test`), so a fresh clone passes with no env
plumbing:

```bash
bun test
```

## Repo layout

```
src/                Bun + TS service (server, db, cache, metrics, admin, lookup, shutdown, types)
tests/              bun:test suite — ephemeral schema, real Redis
scripts/            seed.ts (10k IOCs)  •  capture.ts (bench artifact generator)  •  compare.ts (bench-all aggregator)  •  bootstrap.sh (kind + kubectl downloader)
manifests/          k8s manifests (namespace, postgres, redis, iocheck) + overlays/{cpu-hpa,rps-hpa-4,rps-hpa-8,inflight-hpa} + monitoring/ patches
loadtest/           k6 script + ConfigMap + Job
dashboards/         iocheck Grafana dashboard JSON
Dockerfile          multi-stage Bun image (oven/bun:1.3-slim)
docker-compose.yml  dev-mode stack (not used by the cluster path)
kind-config.yaml    3 workers + 1 control-plane, extraPortMappings
Makefile            7 assessor targets (up/down + 4 bench + bench-all) + internal phases
.claude/plans/      research + implementation plan (durable design context)
EXERCISE.md         the brief (verbatim)
WRITEUP.md          architecture, four challenges, failure mode, future work
logs/               auto-rendered transcripts of every Claude Code session
```

## AI chat logs

The `.claude/settings.json` `Stop` hook renders every Claude Code session to
`logs/<title>.md` automatically. The exercise asks for AI chat logs as a
deliverable; this captures every turn without manual export. JSONL source files
live in `.claude/projects/<encoded-cwd>/` (gitignored); only the rendered
markdown is committed.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `make up` stalls on `wait deployment/keda-operator` | Docker memory < 6 GiB | Raise Docker Desktop → Resources |
| `bun test` fails on `docker compose up`: port 55432/56379 in use | Another container already published one of these ports | `docker ps --filter publish=55432` (or 56379), stop the offender, retry |
| `kubectl: command not found` (manual) | Use `./.bin/kubectl` — the Makefile vendors a pinned copy | n/a |
| Grafana tab doesn't open during bench | `open`/`xdg-open` not available — visit `http://localhost:3000` directly | n/a |
| CPU bench scales up unexpectedly | Per-request CPU higher than calibrated — see `WRITEUP.md` § Challenge 1 for re-tuning | adjust resource request in `manifests/iocheck/deployment.yaml` |

## Credit

Built per the brief in `EXERCISE.md`. Design rationale, prior art and citations
live in `WRITEUP.md`.
