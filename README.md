# iocheck

iocheck is a threat-intel lookup service deployed on a local Kubernetes cluster with autoscaling. This is built for a take-home challenge exercise. The brief can be found in [EXERCISE.md](./EXERCISE.md). Additional information on design and architecture can be found in [WRITEUP.md](./WRITEUP.md).

# Quickstart

Only Docker, git, and make are required on the host. `make up` downloads kind + kubectl into `.bin/` and installs everything else (Bun, KEDA, kube-prometheus, k6) into the cluster, so your local environment stays clean.

```bash
git clone https://github.com/carrein/iocheck && cd iocheck
make up              # create cluster → ~5 minutes: KEDA + Prometheus + iocheck service + DB seeding
make bench-cpu       # CPU-HPA scenario              →  artifacts/cpu-hpa-*
make bench-rps4      # RPS-HPA, max=4 (tight)        →  artifacts/rps-hpa-4-*
make bench-rps8      # RPS-HPA, max=8                →  artifacts/rps-hpa-8-*
make bench-failure   # Prometheus blackout → artifacts/failure-*
make bench-all       # runs cpu + rps4 + rps8 → artifacts/bench-all-*
make down            # tear down cluster
```

All bench targets default to the same workload. `TARGET_RPS=1000`,
`MISS_RATE=0.8` (80% cache-miss / 20% hot). Results are directly
comparable across the autoscaler configurations. Override per run:
`make bench-rps8 MISS_RATE=0.1` for a hot-mix probe, or `MISS_RATE=1`
for an all-miss DB-saturation probe.

Grafana is available at http://localhost:3030.

Each bench prints a summary to stdout when it finishes and writes raw trajectories to the `artifacts/` folder.

# API

A row in `iocs` returns `"malicious"`; otherwise `"unknown"`.

Score is returned as metadata, not used as a threshold.

| Method | Path       | Purpose                                                                 |
| ------ | ---------- | ----------------------------------------------------------------------- |
| `POST` | `/lookup`  | `{type, value}` → `{verdict, ioc?}`                                     |
| `POST` | `/ioc`     | upsert `{type, value, source, score}` — requires `X-Admin-Token` header |
| `GET`  | `/healthz` | liveness                                                                |
| `GET`  | `/readyz`  | 200 when DB + Redis reachable                                           |
| `GET`  | `/metrics` | Prometheus exposition                                                   |

```bash
curl -X POST http://localhost:8080/lookup \
  -H 'content-type: application/json' \
  -d '{"type":"ip","value":"10.0.0.0"}'
```

# Chat Logs

As per instructions listed in [EXERCISE.md](./EXERCISE.md), the chat logs used to scaffold this repository are located in `/logs`. The `.claude/settings.json` `Stop` hook renders every Claude Code session to `logs/<title>.md` automatically.

# Demo

All bench targets share the same workload (80% miss / 20% hot @ 1000 RPS). Autoscaling shape is the only variable. For a hermetic run, the cluster should be reset between scenarios so results are directly comparable.

| Bench           | Description                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `bench-cpu`     | Pods stay at 2. CPU never crosses the 70% threshold under I/O-bound load.                                                     |
| `bench-rps4`    | KEDA scales replicas from 2 toward max=4 within ~60s of burst, then drains back. Tight ceiling.                               |
| `bench-rps8`    | Same trigger as rps4 with max=8. Moderate ceiling shapes the latency profile differently.                                     |
| `bench-failure` | Reuses rps-hpa-8 with Prometheus patched to `replicas=0` at T+75s for 90s.                                                    |
| `bench-all`     | Runs cpu + rps4 + rps8 sequentially (~15 min) and emits `comparison.md` with side-by-side p99, error rate, and peak replicas. |

Each bench writes a timestamped directory under `artifacts/` containing `summary.md`, `k6-stdout.txt`, `replica-trajectory.csv`, `prometheus-snapshots.json`, and `hpa-events.txt`.

# Testing

Run `bun test` to bring up Postgres and Redis via docker-compose and run the IOC test suite. Each run gets a temporary clean database and schema with no extra env setup required.

# Repo Layout

```
src/                Bun + TS service
tests/              bun:test suite
scripts/            seed, capture, compare, bootstrap
manifests/          k8s manifests + overlays/{cpu-hpa,rps-hpa-4,rps-hpa-8}
loadtest/           k6 script + ConfigMap + Job
dashboards/         Grafana dashboard JSON
Dockerfile          multi-stage Bun image
docker-compose.yml  dev-mode stack
kind-config.yaml    kind cluster config
Makefile            assessor targets + internal phases
EXERCISE.md         the brief
WRITEUP.md          architecture and design notes
logs/               auto-rendered Claude Code transcripts
```
