# Session: Debug Grafana dashboard import failure

## User

The full `make up` run output was pasted in (image build, KEDA install,
kube-prometheus apply, iocheck stack), ending with:

```
configuring Grafana for anonymous access...
secret/grafana-config configured
deployment.apps/grafana restarted
…
importing iocheck dashboard into Grafana...
curl: (52) Empty reply from server
make: *** [.grafana-dashboard] Error 52
```

> what happened here
## Assistant

> Bash: grep -n "grafana-dashboard\|port-forward grafana\|grafana" Makefile | head -50

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Bash: grep -n "_start_pf\|_stop_pf\|port-forward grafana already running" Makefile | head -30

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

Diagnosis: a race between Grafana being marked `Available` and being able to serve HTTP, made worse by a stale port-forward.

Sequence:

1. `.monitoring` ran `kubectl rollout restart deployment/grafana` (Makefile:187) to apply the anonymous-access config, then waited on `condition=Available` (Makefile:188).
2. `Available` flips true as soon as the new pod's readiness probe passes — that's a TCP check; the HTTP server can still be in the middle of loading dashboards/datasources.
3. `.grafana-dashboard` then called `_start_pf grafana` (Makefile:217). The helper saw the old port-forward PID alive (`pid 77546`) from a previous run and reused it (Makefile:38-39) — so it never re-tested the socket against the *new* pod, and never waited for HTTP 200.
4. `curl` hit `/api/dashboards/db`, the TCP connection was accepted by the port-forward, but Grafana closed it without sending bytes → curl error 52 ("Empty reply from server").

So: not a deploy failure, just a timing race after the Grafana restart.

Recovery: just rerun — `make up` is idempotent.

```
make up
```

The second pass will skip everything except the dashboard import, and by then Grafana is fully serving.

If you want me to harden this, the right fix is one of:
- In `.grafana-dashboard`, restart the grafana port-forward (`_stop_pf` then `_start_pf`) so it reconnects to the new pod, and
- Poll `GET /api/health` for HTTP 200 (with a short timeout) before posting the dashboard.

Want me to apply that?
