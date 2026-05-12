#!/usr/bin/env bash
# Downloads pinned kind + kubectl binaries into .bin/.
# Idempotent: re-runs are no-ops once binaries exist with the right version.
#
# Host requirements: Docker + bash + curl. That's it.

set -euo pipefail

KIND_VERSION="${KIND_VERSION:-v0.31.0}"
KUBECTL_VERSION="${KUBECTL_VERSION:-v1.32.0}"

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.bin"
mkdir -p "$BIN_DIR"

# Detect OS / arch in the form curl wants.
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) echo "bootstrap: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "bootstrap: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

# Memory sanity check (Docker Desktop on Mac defaults to 4-8GB; we need ~6).
if command -v docker >/dev/null; then
  mem_bytes="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
  mem_gb=$(( mem_bytes / 1024 / 1024 / 1024 ))
  if [ "$mem_gb" -lt 6 ] && [ "$mem_gb" -gt 0 ]; then
    echo "bootstrap: WARNING — Docker has ${mem_gb}GiB memory; recommend >=6GiB for the full stack."
    echo "          Increase under Docker Desktop → Settings → Resources, or expect OOM kills."
  fi
fi

install_kind() {
  local target="$BIN_DIR/kind"
  if [ -x "$target" ] && "$target" version 2>/dev/null | grep -q "$KIND_VERSION"; then
    return 0
  fi
  local url="https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-${OS}-${ARCH}"
  echo "bootstrap: downloading kind ${KIND_VERSION} (${OS}/${ARCH})"
  curl -fsSL -o "$target" "$url"
  chmod +x "$target"
}

install_kubectl() {
  local target="$BIN_DIR/kubectl"
  if [ -x "$target" ] && "$target" version --client 2>/dev/null | grep -q "${KUBECTL_VERSION#v}"; then
    return 0
  fi
  local url="https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${OS}/${ARCH}/kubectl"
  echo "bootstrap: downloading kubectl ${KUBECTL_VERSION} (${OS}/${ARCH})"
  curl -fsSL -o "$target" "$url"
  chmod +x "$target"
}

install_kind
install_kubectl

echo "bootstrap: $("$BIN_DIR/kind" version)"
echo "bootstrap: $("$BIN_DIR/kubectl" version --client | head -n1)"
