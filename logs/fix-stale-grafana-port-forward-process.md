# Session: Fix stale Grafana port-forward process

## User

fix it. (Grafana port-forward looking like a stale-pid situation — pid
file present but localhost:3000 returning connection refused.)

## Assistant

> Bash: ls .bin/pids/ 2>/dev/null; echo "---"; curl -fsS -o /dev/null -w "%{http_code}\n" http://localhost:3...

## Assistant

> Bash: curl -fsS -o /dev/null -w "dashboard: %{http_code}\n" http://localhost:3000/api/dashboards/uid/ioche...

## Assistant

Port-forward is actually fine — Grafana returns 200. The real problem is the `iocheck` dashboard isn't imported (404). Let me re-import it.

## Assistant

> Bash: ls dashboards/ 2>&1

## Assistant

> Bash: grep -n "grafana-dashboard\|dashboards/db\|iocheck.json" Makefile | head -20

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Bash: body=$(bun -e 'const d=await Bun.file("dashboards/iocheck.json").json(); console.log(JSON.stringify(...

## Assistant

> Bash: curl -fsS -u admin:admin -X PUT -H "Content-Type: application/json" -d '{"homeDashboardUID":"iocheck...

## Assistant

Dashboard imported and set as home. Open: http://localhost:3000/d/iocheck?refresh=5s&from=now-15m&to=now
