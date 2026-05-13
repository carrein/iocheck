# Session: Wire health check probes correctly

## User

Liveness, readiness, startup probes wired correctly

is this done

## Assistant

> Bash: grep -rn "Probe\|livenessProbe\|readinessProbe\|startupProbe" /Users/carrein/Desktop/iocheck2/manife...

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/manifests/iocheck/deployment.yaml

## Assistant

> Bash: grep -n "healthz\|readyz" /Users/carrein/Desktop/iocheck2/src/server.ts /Users/carrein/Desktop/ioche...

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/src/server.ts

## Assistant

Yes — wired correctly. `manifests/iocheck/deployment.yaml:55-72`:

- **startupProbe** → `/readyz`, 1s × 30 attempts (30s grace before liveness ticks; Bun dependency-wait can take a moment)
- **livenessProbe** → `/healthz` (always-200 unless the event loop is wedged), 10s period, fail 3×
- **readinessProbe** → `/readyz` (checks DB + Redis via cached `checkReady`, flips to 503 during drain via `isReady`), 5s period, fail 2×

The three roles are correctly differentiated: liveness only restarts a wedged process; readiness gates traffic on dependency health and shutdown drain; startup absorbs cold-start. `shutdown.ts:16` flips `isReady=false` on SIGTERM so `/readyz` returns 503 before the process exits, which lets the Service drop the endpoint cleanly within `terminationGracePeriodSeconds: 30`.
