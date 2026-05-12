# iocheck — assessor-facing Makefile.
#
# Assessor surface (only these are documented in README):
#   make up         bring everything up on a fresh machine
#   make bench-cpu  run the CPU-HPA scenario (5min) + capture artifacts
#   make bench-rps  run the RPS-HPA scenario (5min) + capture artifacts
#   make down       destroy the cluster and clean up host-side state
#
# Host requirements: Docker, bash, curl, git, make. kind + kubectl are
# downloaded into ./.bin/ on first `make up` — nothing else is touched
# outside this directory.

SHELL := /bin/bash

# ---- pinned versions ---------------------------------------------------------
KIND_VERSION       ?= v0.31.0
KUBECTL_VERSION    ?= v1.32.0
KEDA_VERSION       ?= 2.19.0
KP_VERSION         ?= v0.17.0
K8S_NODE_IMAGE     ?= kindest/node:v1.32.0

# ---- paths -------------------------------------------------------------------
BIN_DIR  := $(CURDIR)/.bin
KIND     := $(BIN_DIR)/kind
KUBECTL  := $(BIN_DIR)/kubectl
PIDS_DIR := $(BIN_DIR)/pids
KP_DIR   := $(BIN_DIR)/kube-prometheus

# ---- runtime config ----------------------------------------------------------
IMAGE      := iocheck:dev
CLUSTER    := iocheck
NAMESPACE  := iocheck
PROM_NS    := monitoring

# Background port-forward helpers --------------------------------------------------
define _start_pf
	@mkdir -p $(PIDS_DIR)
	@if [ -f $(PIDS_DIR)/$(1).pid ] && kill -0 $$(cat $(PIDS_DIR)/$(1).pid) 2>/dev/null; then \
	  echo "port-forward $(1) already running (pid $$(cat $(PIDS_DIR)/$(1).pid))"; \
	else \
	  echo "starting port-forward $(1) → $(2):$(3)"; \
	  ( $(KUBECTL) port-forward -n $(4) svc/$(5) $(2):$(3) >$(PIDS_DIR)/$(1).log 2>&1 & echo $$! >$(PIDS_DIR)/$(1).pid ); \
	  for i in $$(seq 1 20); do nc -z 127.0.0.1 $(2) 2>/dev/null && break; sleep 0.25; done; \
	fi
endef

define _stop_pf
	@if [ -f $(PIDS_DIR)/$(1).pid ]; then \
	  pid=$$(cat $(PIDS_DIR)/$(1).pid); \
	  kill $$pid 2>/dev/null || true; \
	  rm -f $(PIDS_DIR)/$(1).pid; \
	  echo "stopped port-forward $(1) (pid $$pid)"; \
	fi
endef

# ---- public targets ----------------------------------------------------------
.PHONY: help
help: ## Show assessor targets
	@echo "iocheck — assessor targets"
	@echo ""
	@echo "  make up         Create kind cluster, deploy everything, seed 10k IOCs."
	@echo "                  Idempotent: re-running is a no-op when already up."
	@echo "  make bench-cpu  CPU-based autoscaler + ~5min load + Grafana + artifacts/"
	@echo "  make bench-rps  RPS-based autoscaler + ~5min load + Grafana + artifacts/"
	@echo "  make down       Destroy cluster, remove .bin/. Keeps artifacts/."
	@echo ""
	@echo "Versions: kind=$(KIND_VERSION) kubectl=$(KUBECTL_VERSION) keda=v$(KEDA_VERSION) kp=$(KP_VERSION)"

.PHONY: up
up: .bootstrap .image .cluster .keda .monitoring .stack .seed .grafana-dashboard ## End-to-end bring-up
	@echo ""
	@echo "================================================================"
	@echo " iocheck cluster is ready."
	@echo ""
	@echo " Next steps:"
	@echo "   make bench-cpu   (CPU autoscaler — fails to scale; demonstrates challenge #1)"
	@echo "   make bench-rps   (RPS autoscaler — scales 2→10→2)"
	@echo "   make down        (tear down)"
	@echo ""
	@echo " Live dashboards (started during bench-*):"
	@echo "   Grafana    http://localhost:3000   (anonymous, lands on iocheck dashboard)"
	@echo "   Prometheus http://localhost:9090"
	@echo "================================================================"

.PHONY: down
down: ## Destroy everything; no residue left in host state
	@$(call _stop_pf,grafana)
	@$(call _stop_pf,prometheus)
	@if [ -f $(PIDS_DIR)/capture.pid ]; then \
	  pid=$$(cat $(PIDS_DIR)/capture.pid); kill -TERM $$pid 2>/dev/null || true; \
	  rm -f $(PIDS_DIR)/capture.pid; \
	fi
	@if [ -x $(KIND) ]; then \
	  $(KIND) delete cluster --name $(CLUSTER) 2>/dev/null || true; \
	fi
	@rm -rf $(BIN_DIR)
	@echo ""
	@echo "cluster destroyed. .bin/ removed. artifacts/ retained."
	@echo "(docker images for iocheck/postgres/redis/etc remain cached;"
	@echo " run 'docker image prune' to remove them.)"

.PHONY: bench-cpu
bench-cpu: SCENARIO := cpu-hpa
bench-cpu: ## CPU-based HPA scenario + load test + artifacts
	@$(MAKE) _bench SCENARIO=cpu-hpa OVERLAY=manifests/overlays/cpu-hpa OTHER_OVERLAY=manifests/overlays/rps-hpa

.PHONY: bench-rps
bench-rps: SCENARIO := rps-hpa
bench-rps: ## RPS-based HPA scenario + load test + artifacts
	@$(MAKE) _bench SCENARIO=rps-hpa OVERLAY=manifests/overlays/rps-hpa OTHER_OVERLAY=manifests/overlays/cpu-hpa

# ---- private targets ---------------------------------------------------------
.PHONY: .bootstrap
.bootstrap:
	@bash $(CURDIR)/scripts/bootstrap.sh

.PHONY: .image
.image: .bootstrap
	@echo "building $(IMAGE)..."
	@docker build -t $(IMAGE) $(CURDIR) >/dev/null
	@echo "image built: $$(docker images $(IMAGE) --format '{{.Size}}')"

.PHONY: .cluster
.cluster: .bootstrap .image
	@if $(KIND) get clusters 2>/dev/null | grep -q "^$(CLUSTER)$$"; then \
	  echo "kind cluster '$(CLUSTER)' already exists"; \
	else \
	  echo "creating kind cluster '$(CLUSTER)' (3 workers + 1 control-plane)..."; \
	  $(KIND) create cluster --name $(CLUSTER) --image $(K8S_NODE_IMAGE) --config $(CURDIR)/kind-config.yaml; \
	fi
	@echo "loading image into kind..."
	@$(KIND) load docker-image $(IMAGE) --name $(CLUSTER)

.PHONY: .keda
.keda: .cluster
	@echo "installing KEDA v$(KEDA_VERSION)..."
	@$(KUBECTL) apply --server-side -f \
	  https://github.com/kedacore/keda/releases/download/v$(KEDA_VERSION)/keda-$(KEDA_VERSION).yaml
	@$(KUBECTL) wait --for=condition=Available --timeout=180s \
	  -n keda deployment/keda-operator deployment/keda-metrics-apiserver deployment/keda-admission

.PHONY: .monitoring
.monitoring: .cluster
	@if [ ! -d $(KP_DIR) ]; then \
	  echo "cloning kube-prometheus $(KP_VERSION)..."; \
	  git clone --depth=1 --branch $(KP_VERSION) \
	    https://github.com/prometheus-operator/kube-prometheus $(KP_DIR) >/dev/null 2>&1; \
	fi
	@echo "applying kube-prometheus CRDs..."
	@$(KUBECTL) apply --server-side -f $(KP_DIR)/manifests/setup
	@$(KUBECTL) wait --for=condition=Established --timeout=60s --all CustomResourceDefinition
	@echo "applying kube-prometheus components (skipping alertmanager + blackbox to fit kind RAM budget)..."
	@# kube-prometheus's manifests/ directory holds one resource per file. We
	@# move the alertmanager + blackbox files out before apply, then restore so
	@# the .bin/kube-prometheus clone is left in a clean state.
	@mkdir -p $(KP_DIR)/.skipped
	@find $(KP_DIR)/manifests -maxdepth 1 -name 'alertmanager-*' -exec mv {} $(KP_DIR)/.skipped/ \;
	@find $(KP_DIR)/manifests -maxdepth 1 -name 'blackboxExporter-*' -exec mv {} $(KP_DIR)/.skipped/ \;
	@$(KUBECTL) apply -f $(KP_DIR)/manifests
	@mv $(KP_DIR)/.skipped/* $(KP_DIR)/manifests/ 2>/dev/null || true
	@rmdir $(KP_DIR)/.skipped 2>/dev/null || true
	@echo "patching Prometheus CR (enable remote-write-receiver, set retention)..."
	@# Use merge patch — applying the partial Prometheus CR would clobber
	@# fields (notably podMetadata.labels) the operator needs to populate
	@# the Service selector.
	@$(KUBECTL) patch prometheus k8s -n $(PROM_NS) --type=merge \
	  --patch-file=$(CURDIR)/manifests/monitoring/prometheus-cr-patch.yaml
	@# Upstream NetworkPolicy on prometheus-k8s only allows Grafana + adapter ingress.
	@# Extend to KEDA (autoscaler queries) and any monitoring-labelled namespace
	@# (k6 remote-write).
	@$(KUBECTL) apply -f $(CURDIR)/manifests/monitoring/prometheus-netpol-patch.yaml
	@# Override Grafana's grafana.ini to enable anonymous Admin access (no login
	@# wall) and roll the deployment so the new config is mounted. Must come
	@# after the kube-prometheus apply above, otherwise it would be clobbered.
	@echo "configuring Grafana for anonymous access..."
	@$(KUBECTL) apply -f $(CURDIR)/manifests/monitoring/grafana-config.yaml
	@$(KUBECTL) -n $(PROM_NS) rollout restart deployment/grafana
	@$(KUBECTL) -n $(PROM_NS) wait --for=condition=Available --timeout=300s deployment/grafana deployment/prometheus-operator
	@$(KUBECTL) -n $(PROM_NS) rollout status statefulset/prometheus-k8s --timeout=300s

.PHONY: .stack
.stack: .cluster .monitoring
	@echo "applying iocheck stack (namespace, postgres, redis, iocheck)..."
	@$(KUBECTL) apply -k $(CURDIR)/manifests
	@# kube-prometheus only creates the prometheus-k8s Role in default/kube-system/monitoring.
	@# We need it in iocheck too so the operator can list our pods/services/endpoints.
	@$(KUBECTL) apply -f $(CURDIR)/manifests/monitoring/prometheus-rbac-iocheck.yaml
	@# The prometheus-operator caches the namespace list; without a poke, it can
	@# miss the newly-labelled iocheck namespace and our ServiceMonitor won't
	@# generate a scrape job. A rollout restart forces a re-sync.
	@$(KUBECTL) rollout restart deployment prometheus-operator -n $(PROM_NS) >/dev/null
	@$(KUBECTL) rollout status deployment prometheus-operator -n $(PROM_NS) --timeout=60s >/dev/null
	@echo "waiting for postgres + redis..."
	@$(KUBECTL) -n $(NAMESPACE) wait --for=condition=Ready pod -l app=postgres --timeout=180s
	@$(KUBECTL) -n $(NAMESPACE) wait --for=condition=Ready pod -l app=redis --timeout=120s

.PHONY: .seed
.seed: .stack
	@echo "running seed job (10k IOCs)..."
	@$(KUBECTL) -n $(NAMESPACE) wait --for=condition=Complete --timeout=180s job/iocheck-seed || \
	  ($(KUBECTL) -n $(NAMESPACE) logs job/iocheck-seed && false)
	@echo "waiting for iocheck pods..."
	@$(KUBECTL) -n $(NAMESPACE) rollout status deployment/iocheck --timeout=180s

.PHONY: .grafana-dashboard
.grafana-dashboard: .monitoring
	@$(call _start_pf,grafana,3000,3000,$(PROM_NS),grafana)
	@echo "importing iocheck dashboard into Grafana..."
	@bash -c '\
	  body=$$(bun -e "const d=await Bun.file(\"dashboards/iocheck.json\").json(); console.log(JSON.stringify({dashboard:{...d,id:null,uid:\"iocheck\"},overwrite:true,inputs:[],folderId:0}))"); \
	  curl -fsS -u admin:admin -H "Content-Type: application/json" \
	    -d "$$body" \
	    http://127.0.0.1:3000/api/dashboards/db >/dev/null && \
	  echo "dashboard imported → http://localhost:3000/d/iocheck"'
	@# Set the iocheck dashboard as the org's home dashboard so the root URL
	@# (and the anonymous landing page) goes straight to it.
	@curl -fsS -u admin:admin -X PUT -H "Content-Type: application/json" \
	  -d '{"homeDashboardUID":"iocheck"}' \
	  http://127.0.0.1:3000/api/org/preferences >/dev/null
	@echo "set iocheck as Grafana home dashboard"

.PHONY: _bench
_bench:
	@if [ -z "$(SCENARIO)" ] || [ -z "$(OVERLAY)" ]; then \
	  echo "_bench: SCENARIO and OVERLAY must be set"; exit 1; \
	fi
	@if ! $(KIND) get clusters 2>/dev/null | grep -q "^$(CLUSTER)$$"; then \
	  echo "cluster not running. Run 'make up' first."; exit 1; \
	fi

	@echo ""
	@echo "================================================================"
	@echo " bench: $(SCENARIO)"
	@echo "================================================================"

	# Swap the autoscaler overlay.
	@echo "[1/6] applying overlay $(OVERLAY); removing $(OTHER_OVERLAY)..."
	@$(KUBECTL) delete --ignore-not-found -k $(OTHER_OVERLAY) 2>/dev/null || true
	@$(KUBECTL) apply -k $(OVERLAY)
	@$(KUBECTL) -n $(NAMESPACE) wait --for=condition=Ready scaledobject \
	  -l app.kubernetes.io/managed-by=keda-operator --timeout=60s 2>/dev/null || true
	@sleep 3

	# Refresh k6 ConfigMap from disk (in case the script was edited).
	@echo "[2/6] refreshing k6 script ConfigMap..."
	@$(KUBECTL) -n $(NAMESPACE) create configmap k6-script \
	  --from-file=script.js=$(CURDIR)/loadtest/script.js \
	  --dry-run=client -o yaml | $(KUBECTL) apply -f -

	# Kill any prior k6 Job so we can re-run.
	@$(KUBECTL) -n $(NAMESPACE) delete job k6-load --ignore-not-found

	# Start Prometheus + Grafana port-forwards.
	@echo "[3/6] starting port-forwards..."
	@$(call _start_pf,prometheus,9090,9090,$(PROM_NS),prometheus-k8s)
	@$(call _start_pf,grafana,3000,3000,$(PROM_NS),grafana)

	# Launch the k6 Job with scenario-tagged metrics.
	@testid=$$(date +%Y%m%dT%H%M%SZ); \
	 echo "[4/6] launching k6 (scenario=$(SCENARIO), testid=$$testid)..."; \
	 sed -e "s/value: \"unknown\"$$/value: \"$(SCENARIO)\"/" \
	     -e "s/value: \"0\"$$/value: \"$$testid\"/" \
	     $(CURDIR)/loadtest/job.yaml | $(KUBECTL) apply -f -

	@echo ""
	@echo "    Grafana: http://localhost:3000/d/iocheck?refresh=5s&from=now-2m&to=now%2B15m"
	@echo "    (anonymous access — no login required)"
	@echo ""

	# Start the capture script in the background; tee k6 logs.
	@artdir=artifacts/$(SCENARIO)-$$(date +%Y%m%dT%H%M%SZ); \
	 mkdir -p $$artdir; \
	 echo "[5/6] artifacts → $$artdir"; \
	 ARTIFACT_DIR=$$artdir SCENARIO=$(SCENARIO) PROM_URL=http://localhost:9090 \
	   KUBECTL=$(KUBECTL) \
	   bun run $(CURDIR)/scripts/capture.ts > $$artdir/capture.log 2>&1 & \
	 echo $$! > $(PIDS_DIR)/capture.pid; \
	 echo "[6/6] streaming k6 output (Ctrl-C to stop early)..."; \
	 sleep 5; \
	 $(KUBECTL) -n $(NAMESPACE) wait --for=condition=Ready pod -l job-name=k6-load --timeout=60s || true; \
	 ($(KUBECTL) -n $(NAMESPACE) logs -f -l job-name=k6-load --tail=-1 2>/dev/null | tee $$artdir/k6-stdout.txt) || true; \
	 $(KUBECTL) -n $(NAMESPACE) wait --for=condition=Complete --timeout=900s job/k6-load 2>/dev/null || \
	   $(KUBECTL) -n $(NAMESPACE) wait --for=condition=Failed --timeout=30s job/k6-load 2>/dev/null || true; \
	 if [ -f $(PIDS_DIR)/capture.pid ]; then \
	   pid=$$(cat $(PIDS_DIR)/capture.pid); kill -TERM $$pid 2>/dev/null || true; \
	   wait $$pid 2>/dev/null || true; \
	   rm -f $(PIDS_DIR)/capture.pid; \
	 fi; \
	 echo ""; \
	 echo "================================================================"; \
	 echo " bench complete → $$artdir/summary.md"; \
	 echo "================================================================"; \
	 cat $$artdir/summary.md 2>/dev/null || true
