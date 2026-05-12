# iocheck

A small threat-intel lookup service built for the take-home in [`EXERCISE.md`](./EXERCISE.md).
Design discussion in [`WRITEUP.md`](./WRITEUP.md); AI session transcripts in [`logs/`](./logs/).

## Quickstart

**Host requirements:** Docker (≥ 24), `git`, `make`, `bash`, `curl`.
That's it — `kind` and `kubectl` get downloaded into `./.bin/` by `make up`.

```bash
git clone <repo> && cd iocheck
make up              # ~5–6 min: cluster + KEDA + Prometheus + service + seed
make bench-cpu       # ~5 min: CPU-HPA scenario       →  artifacts/cpu-hpa-<ts>/
make bench-rps       # ~5 min: RPS-HPA scenario       →  artifacts/rps-hpa-<ts>/
make bench-rps-miss  # ~5 min: RPS-HPA + all-miss     →  artifacts/rps-hpa-cold-<ts>/
make down            # destroys cluster, removes .bin/
```

`bench-rps-miss` is the 100%-cache-miss variant — every lookup misses the
cache and goes to Postgres. It's the workload regime where RPS scaling can
add pods that all then queue on the same finite DB pool, exposing the
caveat discussed in `WRITEUP.md` § "Beyond the wrong-signal answer".

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
- **Autoscaling** via KEDA `ScaledObject`s — two overlays:
  - `cpu-hpa`: CPU at 70% of request (the "wrong" signal from the brief)
  - `rps-hpa`: cluster RPS / replicas = 100 RPS-per-pod (the "right" signal),
    with `fallback.replicas: 4` for Prometheus-down resilience.
- **Observability**: kube-prometheus (Prometheus + Grafana + node-exporter +
  kube-state-metrics + prometheus-adapter). Custom dashboard
  `dashboards/iocheck.json` imported automatically at `make up`.
- **Load**: k6 (`grafana/k6:1.3.0`) as an in-cluster Job, `ramping-arrival-rate`
  open-model executor, 60s ramp → 4 min @ 1000 RPS → 5 min drain. Pushes
  metrics to Prometheus via remote-write.

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

1. **`make bench-cpu`** — pods stay at 2, CPU peaks ~50–60% (below 70%
   threshold), p99 walls at 1–3 s. Demonstrates Challenge 1: CPU is the wrong
   signal for an I/O-bound cache-friendly read workload.
2. **`make bench-rps`** — KEDA reads `sum(rate(http_requests_total[1m]))` from
   Prometheus, scales replicas 2 → ~10 within 60 s of burst, p99 stays below
   200 ms. After drain, scales back to 2.
3. Each bench drops a markdown summary into `artifacts/`:
   ```
   artifacts/rps-hpa-20260512T1442Z/
     summary.md                  ← human-readable, also printed to stdout
     k6-stdout.txt               ← full k6 output
     replica-trajectory.csv      ← pod count sampled every 5 s
     prometheus-snapshots.json   ← PromQL series for the test window
     hpa-events.txt              ← kubectl describe hpa
   ```

The walkthrough talks through both: same load, same cluster, only the
ScaledObject changes.

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
scripts/            seed.ts (10k IOCs)  •  capture.ts (bench artifact generator)  •  bootstrap.sh (kind + kubectl downloader)
manifests/          k8s manifests (namespace, postgres, redis, iocheck) + overlays/{cpu-hpa,rps-hpa} + monitoring/ patches
loadtest/           k6 script + ConfigMap + Job
dashboards/         iocheck Grafana dashboard JSON
Dockerfile          multi-stage Bun image (oven/bun:1.3-slim)
docker-compose.yml  dev-mode stack (not used by the cluster path)
kind-config.yaml    3 workers + 1 control-plane, extraPortMappings
Makefile            4 assessor targets + internal phases
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
