# Session: Configure Grafana for anonymous access and default dashboard

## User

Update Grafana so no login/authorization needed. When Grafana is opened, automatically show the ioc dashboard by default. Do not open a new Grafana window - user’s will navigate themselves.

## Assistant

> Bash: find /Users/carrein/Desktop/iocheck2 -type f \( -name "*.yaml" -o -name "*.yml" -o -name "*.json" -o...

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Bash: ls /Users/carrein/Desktop/iocheck2/manifests/monitoring/

## Assistant

Looking at this, I need to:
1. Make Grafana skip login (anonymous auth)
2. Make the IOC dashboard the home dashboard
3. Remove the `open`/`xdg-open` lines so no browser is auto-opened

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/manifests/monitoring/prometheus-cr-patch.yaml

## Assistant

Now let me create the Grafana config override.

## Assistant

> Write: /Users/carrein/Desktop/iocheck2/manifests/monitoring/grafana-config.yaml

## Assistant

Now patch the Makefile: apply the grafana-config override + restart grafana in `.monitoring`, set the home dashboard in `.grafana-dashboard`, and remove the auto-open block in `_bench`.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

Now remove the auto-open browser block from `_bench` and update the `up` summary to clarify how to navigate.

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Bash: grep -n -i "admin/admin\|grafana.*login\|grafana.*password\|grafana.*credential" /Users/carrein/Desk...

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/README.md

## Assistant

> Edit: /Users/carrein/Desktop/iocheck2/README.md

## Assistant

> Bash: grep -n -i "admin/admin\|grafana.*login\|grafana.*password\|open.*grafana\|grafana.*opens\|automatic...

## Assistant

> Bash: grep -n -i "grafana" /Users/carrein/Desktop/iocheck2/WRITEUP.md 2>/dev/null | head -20

## Assistant

Let me verify the final Makefile state.

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

> Read: /Users/carrein/Desktop/iocheck2/Makefile

## Assistant

All changes applied. Summary:

**New file**: `manifests/monitoring/grafana-config.yaml` — Secret overriding kube-prometheus's `grafana-config` with `auth.anonymous.enabled = true` (Admin role), `disable_login_form = true`.

**Makefile changes**:
- `.monitoring`: applies the override after kube-prometheus and `rollout restart deployment/grafana` so the new `grafana.ini` is mounted; the existing `wait --for=Available` covers the restart.
- `.grafana-dashboard`: after dashboard import, PUTs `/api/org/preferences` with `homeDashboardUID:"iocheck"` so `http://localhost:3000/` lands on the iocheck dashboard.
- `_bench`: removed the `open`/`xdg-open` block; replaced with a printed URL.
- `up` summary: removed the stale `admin/admin` hint.

**README** quickstart updated to drop the "tab opens automatically" / `admin/admin` line.

Next time `make up` runs, visit <http://localhost:3000> manually — anonymous access lands on the iocheck dashboard with no login.
