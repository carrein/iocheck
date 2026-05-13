# CLAUDE.md

Guidance for Claude Code sessions in this repository.

## What this repo is

**iocheck** — a take-home implementation for the brief in [`EXERCISE.md`](./EXERCISE.md):
a Bun + TypeScript threat-intel lookup service on a local kind Kubernetes cluster,
with a KEDA-managed custom-metric HPA that beats CPU-based autoscaling on this
workload. End-user docs: [`README.md`](./README.md) (quickstart) and
[`WRITEUP.md`](./WRITEUP.md) (architecture, four challenges, future work).

`.envrc` sets `CLAUDE_CONFIG_DIR="$PWD/.claude"` (direnv), so Claude Code uses
in-repo config rather than user-global `~/.claude`. Run `direnv allow` after cloning.

## Assessor-facing surface

Seven Make targets — bring-up / tear-down, four bench scenarios, plus the
`bench-all` aggregator that runs the three throughput benches under a single
run dir. Anything more granular is a private `.`-prefixed phase.

```
make up              # download .bin/{kind,kubectl}, create cluster, deploy, seed 10k IOCs
make bench-cpu       # CPU-HPA scenario              + load + Grafana + artifacts/
make bench-rps4      # RPS-HPA (max=4, tight)        + load + Grafana + artifacts/
make bench-rps8      # RPS-HPA (max=8, moderate)     + load + Grafana + artifacts/
make bench-failure   # RPS-HPA + Prometheus blackout (writeup §4 fallback)
make bench-all       # cpu + rps4 + rps8 → artifacts/bench-all-<ts>/comparison.md
make down            # destroy cluster, remove .bin/, keep artifacts/
```

All `bench-*` targets share the same default workload — `MISS_RATE=0.8`,
`TARGET_RPS=1000` — so the results are directly comparable. Override per run
(e.g. `MISS_RATE=0.1` for a hot-mix probe). Profile: 30s ramp + 90s sustain
+ 30s drain + 2 min post-k6 observation window for scale-down capture.

`bench-failure` is the writeup §4 fallback validation: it reuses the
rps-hpa-8 overlay and patches the Prometheus StatefulSet to replicas=0
at T+75s (held for 90s) to test KEDA's `fallback.replicas` +
`behavior: currentReplicasIfHigher` claim. The `capture.ts` script polls
the KEDA-HPA's `ScalingActive` condition so the fallback fire moment is
captured in `summary.md`.

`bench-all` runs cpu-hpa + rps-hpa-4 + rps-hpa-8 sequentially (excludes
`bench-failure` — that asks a different question) under a single
`artifacts/bench-all-<ts>/` root, and emits `comparison.md` with a
side-by-side headline table. The aggregator (`scripts/compare.ts`) reads
each sub-bench's `summary.json` (a sibling to `summary.md` produced by
`capture.ts`); a missing `summary.json` is treated as a failed sub-bench
and rendered as a flagged row. `_bench` honors an external `ARTIFACT_DIR`
env var (set by `bench-all`) so all three sub-benches write into the
shared run dir; standalone `bench-*` invocations keep the legacy
`artifacts/<scenario>-<mode>-<ts>/` sibling layout.

Host floor: Docker + git + make. Bun, kubectl, kind, KEDA, kube-prometheus, k6 —
all downloaded or cluster-installed by `make up`.

## Layout

- `src/` — Bun service (`server.ts`, `db.ts`, `cache.ts`, `metrics.ts`, `lookup.ts`,
  `admin.ts`, `shutdown.ts`, `types.ts`)
- `tests/` — `bun:test` suite (`setup.ts` creates an ephemeral schema)
- `scripts/` — `bootstrap.sh` (kind/kubectl downloader), `seed.ts` (10k IOCs),
  `capture.ts` (bench artifact generator), `compare.ts` (bench-all aggregator),
  `pf.sh` (supervised `kubectl port-forward`; auto-reconnects when the bound pod is replaced)
- `manifests/` — namespace, postgres, redis, iocheck, monitoring patches,
  Kustomize overlays under `manifests/overlays/{cpu-hpa,rps-hpa-4,rps-hpa-8}/`
- `loadtest/` — k6 script, ConfigMap, Job
- `dashboards/` — Grafana dashboard JSON, auto-imported by `make up`
- `Dockerfile`, `docker-compose.yml`, `kind-config.yaml`, `Makefile`
- `.claude/plans/iocheck-plan.md` + `iocheck-research.md` + `bench-all-plan.md` —
  durable design context; read these before re-deriving decisions or proposing
  changes to calibrated values
- `.claude/projects/.../memory/` — per-project memory (user preferences, project facts)

## Claude infrastructure

- `.claude/settings.json` — tracked. Registers a single `Stop` hook.
- `.claude/render-session.py` — tracked Stop-hook script.
- `.claude/skills/` — symlinks to `~/.claude/skills/carrein-*` (gitignored;
  recreate by symlinking).
- `.claude/` everything else — runtime state, gitignored.
- `logs/` — markdown transcripts produced by the Stop hook (EXERCISE.md deliverable
  for "AI chat logs").

### Session renderer hook

`.claude/settings.json` runs `python3 .claude/render-session.py` on every `Stop`
event. The script:

1. Reads `transcript_path` from the hook payload on stdin and waits for the JSONL
   file to stabilize (`wait_for_stable`, max 2s).
2. Walks the events: emits `## User` blocks for plain-text user turns and
   `## Assistant` blocks for assistant turns, summarizing each `tool_use` block as
   `> ToolName: <command|file_path|description|pattern>` (truncated at 100 chars).
3. Writes the markdown to `logs/<slug>.md` where the slug is the kebab-cased
   `aiTitle` if one has been emitted, otherwise the `sessionId`. When a title
   appears later, the older `<sessionId>.md` file is deleted so each session has
   exactly one log.

`CLAUDE_PROJECT_DIR` (set by the harness) determines the `logs/` location; it
falls back to `cwd`.

When editing the renderer, remember the contract: it must accept the Stop-hook
JSON payload on stdin, must not raise on malformed transcripts (the `try/except`
around `json.loads` is load-bearing — sessions are read while still being
written), and must be idempotent if run twice on the same transcript.

## Development conventions

- TypeScript strict mode (`tsconfig.json`); typecheck with `bunx tsc --noEmit`.
- Tests run with `DATABASE_URL` + `REDIS_URL` pointing at a real Postgres + Redis
  (the `bun:test` `setup.ts` creates and tears down an ephemeral schema per run).
- Comments: only where the *why* is non-obvious (subtle invariant, vendor gotcha
  documented inline in YAML, etc.). Don't narrate what the code does.
- Calibrated values (resources, replicas, RPS targets, scale windows) have
  rationale in `.claude/plans/iocheck-plan.md` and `WRITEUP.md`. Don't change
  them blind to those documents.
