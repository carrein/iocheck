#!/usr/bin/env bash
# Supervised kubectl port-forward.
#
# kubectl port-forward to a Service binds to one endpoint pod when it starts.
# If that pod is replaced (rollout, eviction, OOM), the forward dies with
# "lost connection to pod" and the host port goes dark — even though the
# Service itself is still healthy and a new pod is up. The Makefile's
# _start_pf macro previously launched kubectl directly in the background,
# so a single pod replacement left the port silently dead until the next
# explicit _start_pf call. That's the bug behind "Grafana on :3000 stops
# working after make up": .monitoring's `rollout restart deployment/grafana`
# can replace the pod after the forward attached, the forward dies, and
# nothing restarts it.
#
# This wrapper supervises: when kubectl exits non-zero, sleep 1s and
# reconnect. On SIGTERM/SIGINT (from _stop_pf or Ctrl-C) it propagates to
# the kubectl child so we don't leave orphans.
#
# Usage: pf.sh <kubectl> <namespace> <service> <local_port>:<svc_port>
set -uo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <kubectl> <namespace> <service> <local:svc>" >&2
  exit 2
fi

KUBECTL="$1"; NS="$2"; SVC="$3"; PORTS="$4"
KPID=""

cleanup() {
  if [ -n "$KPID" ]; then
    kill "$KPID" 2>/dev/null || true
    wait "$KPID" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup TERM INT

while true; do
  "$KUBECTL" port-forward -n "$NS" "svc/$SVC" "$PORTS" &
  KPID=$!
  wait "$KPID"
  rc=$?
  KPID=""
  echo "[pf $SVC] kubectl port-forward exited rc=$rc — reconnecting in 1s" >&2
  sleep 1
done
