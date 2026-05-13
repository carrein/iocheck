# iocheck — assessor-facing Makefile.
#
# Assessor surface (only these are documented in README):
#   make up              bring everything up on a fresh machine
#   make bench-cpu       CPU-HPA scenario + capture artifacts
#   make bench-rps4      RPS-HPA (max=4) + capture artifacts
#   make bench-rps8      RPS-HPA (max=8) + capture artifacts
#   make bench-failure   RPS-HPA + Prometheus blackout (writeup §4)
#   make bench-all       run the 3 throughput benches + emit comparison table
#   make down            destroy the cluster and clean up host-side state
#
# All bench-* targets default to MISS_RATE=0.8 + TARGET_RPS=1000 (80%
# cache-miss / 20% hot) so the comparison runs the same workload across
# autoscaler configs. Override per run: `make bench-rps8 MISS_RATE=0.1`
# for a hot-mix probe.
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
	@echo "  make up              Create kind cluster, deploy everything, seed 10k IOCs."
	@echo "                       Idempotent: re-running is a no-op when already up."
	@echo "  make bench-cpu       CPU-HPA autoscaler            + Grafana + artifacts/"
	@echo "  make bench-rps4      RPS-HPA (max=4, tight)        + Grafana + artifacts/"
	@echo "  make bench-rps8      RPS-HPA (max=8, moderate)     + Grafana + artifacts/"
	@echo "  make bench-failure   RPS-HPA + Prometheus blackout (writeup §4)"
	@echo "  make bench-all       Run cpu + rps4 + rps8, emit side-by-side table"
	@echo "  make down            Destroy cluster, remove .bin/. Keeps artifacts/."
	@echo ""
	@echo "Default workload: TARGET_RPS=1000, MISS_RATE=0.8 (80% miss / 20% hot)."
	@echo "Override per run, e.g. MISS_RATE=0.1 for hot-mix or MISS_RATE=1 for all-miss."
	@echo ""
	@echo "Versions: kind=$(KIND_VERSION) kubectl=$(KUBECTL_VERSION) keda=v$(KEDA_VERSION) kp=$(KP_VERSION)"

.PHONY: up
up: .bootstrap .image .cluster .keda .monitoring .stack .seed .grafana-dashboard ## End-to-end bring-up
	@echo ""
	@echo "================================================================"
	@echo " iocheck cluster is ready."
	@echo ""
	@echo " Next steps (all default to MISS_RATE=0.8 / TARGET_RPS=1000):"
	@echo "   make bench-cpu       (CPU autoscaler — wrong signal for I/O-bound workload)"
	@echo "   make bench-rps4      (RPS autoscaler, max=4 — tight horizontal ceiling)"
	@echo "   make bench-rps8      (RPS autoscaler, max=8 — moderate)"
	@echo "   make bench-failure   (Prometheus blackout mid-burst, writeup §4 fallback)"
	@echo "   make bench-all       (run cpu + rps4 + rps8 → artifacts/bench-all-<ts>/comparison.md)"
	@echo "   make down            (tear down)"
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

# ---- four-way bench grid -----------------------------------------------------
# All targets share the same default workload (MISS_RATE=0.8, TARGET_RPS=1000)
# so results are comparable. Override per run: `make bench-rps8 MISS_RATE=0.1`.
.PHONY: bench-cpu bench-rps4 bench-rps8 bench-failure bench-all

bench-cpu: ## CPU-HPA scenario — wrong signal on an I/O-bound workload
	@$(MAKE) _bench SCENARIO=cpu-hpa OVERLAY=manifests/overlays/cpu-hpa MISS_RATE=$(MISS_RATE)

bench-rps4: ## RPS-HPA with maxReplicaCount=4 (very tight horizontal ceiling)
	@$(MAKE) _bench SCENARIO=rps-hpa-4 OVERLAY=manifests/overlays/rps-hpa-4 MISS_RATE=$(MISS_RATE)

bench-rps8: ## RPS-HPA with maxReplicaCount=8 (moderate ceiling)
	@$(MAKE) _bench SCENARIO=rps-hpa-8 OVERLAY=manifests/overlays/rps-hpa-8 MISS_RATE=$(MISS_RATE)

bench-failure: ## RPS-HPA + Prometheus blackout @ T+75s for 90s (writeup §4 fallback)
	@$(MAKE) _bench SCENARIO=failure OVERLAY=manifests/overlays/rps-hpa-8 MISS_RATE=$(MISS_RATE) BLACKOUT_AT_S=75 BLACKOUT_DUR_S=90

# bench-all: runs the three throughput benches under a shared run dir and
# emits a side-by-side comparison.md. Skips bench-failure — that tests a
# different question (resilience under metric outage, writeup §4) and
# doesn't fit the throughput comparison cleanly.
#
# Layout: artifacts/bench-all-<ts>/{cpu-hpa,rps-hpa-4,rps-hpa-8}/ + comparison.md
# Wall clock: ~15 min (3 × ~5 min). Failure of any one sub-bench is
# non-fatal — the run continues and the failing row is flagged in the table;
# the overall exit code is non-zero if any sub-bench failed.
bench-all: ## Run cpu/rps4/rps8 sequentially, emit comparison table
	@if ! $(KIND) get clusters 2>/dev/null | grep -q "^$(CLUSTER)$$"; then \
	  echo "cluster not running. Run 'make up' first."; exit 1; \
	fi
	@ts=$$(date +%Y%m%dT%H%M%SZ); \
	 root=artifacts/bench-all-$$ts; \
	 mkdir -p $$root; \
	 echo ""; \
	 echo "================================================================"; \
	 echo " bench-all: cpu-hpa + rps-hpa-4 + rps-hpa-8 → $$root"; \
	 echo " wall clock ~15 min; failures are non-fatal (logged in comparison)"; \
	 echo "================================================================"; \
	 rc=0; \
	 ARTIFACT_DIR=$$root/cpu-hpa   $(MAKE) bench-cpu  MISS_RATE=$(MISS_RATE) || rc=1; \
	 ARTIFACT_DIR=$$root/rps-hpa-4 $(MAKE) bench-rps4 MISS_RATE=$(MISS_RATE) || rc=1; \
	 ARTIFACT_DIR=$$root/rps-hpa-8 $(MAKE) bench-rps8 MISS_RATE=$(MISS_RATE) || rc=1; \
	 echo ""; \
	 echo "[bench-all] aggregating → $$root/comparison.md"; \
	 bun run $(CURDIR)/scripts/compare.ts $$root || rc=1; \
	 echo ""; \
	 echo "================================================================"; \
	 echo " bench-all complete → $$root/comparison.md (rc=$$rc)"; \
	 echo "================================================================"; \
	 exit $$rc

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
# Workload knob: MISS_RATE (single source of truth).
#   MISS_RATE   fraction of requests hitting a random (uncached) IOC.
#                 0.0–0.1               → "hot"     — cache absorbs ≥90%
#                 0.8 (default)         → "miss80"  — 80% miss / 20% hot
#                 1                     → "cold"    — DB-saturation probe
#   TARGET_RPS  1000 cluster-wide for every bench (low-variance baseline).
#   MODE        human tag used in the artifact directory name.
# `override` is load-bearing: each bench-* target forwards MISS_RATE=$(MISS_RATE)
# to the recursive make, which sends MISS_RATE="" (empty) when the outer caller
# didn't set it. Command-line variables beat target-specific ones in make, so
# without `override` the empty string would stick and the default never fire.
_bench: override MISS_RATE  := $(if $(MISS_RATE),$(MISS_RATE),0.8)
_bench: TARGET_RPS          := 1000
_bench: MODE                := $(if $(filter 1.0 1,$(MISS_RATE)),cold,$(if $(filter 0.0 0.1,$(MISS_RATE)),hot,miss$(shell awk "BEGIN{printf \"%d\", $(MISS_RATE)*100}")))
# k6 is 2:30 (30s ramp + 90s sustain + 30s drain). 90s sustain is
# enough for the slowest autoscaler (CPU-HPA, ~80s to first scale) to
# react and for the faster RPS scalers to land a distinguishable
# steady-state p99 reading. Then we hold for POST_K6_OBSERVE_S so KEDA
# can walk replicas back down. 120s captures the first scale-down steps
# without inflating the total bench wall clock beyond ~5 min.
_bench: POST_K6_OBSERVE_S := 120
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

	# Reset iocheck to base then apply the scenario overlay. Re-applying
	# the base before the overlay clears any previous scenario's
	# ScaledObject and returns the Deployment to its 2-replica baseline,
	# so each bench starts from the same shape.
	@echo "[1/7] reset + apply overlay $(OVERLAY)..."
	@$(KUBECTL) apply -k $(CURDIR)/manifests/iocheck >/dev/null
	@$(KUBECTL) -n $(NAMESPACE) delete scaledobject --all --ignore-not-found >/dev/null 2>&1 || true
	@$(KUBECTL) apply -k $(OVERLAY)
	@if $(KUBECTL) -n $(NAMESPACE) get scaledobject --no-headers 2>/dev/null | grep -q .; then \
	  $(KUBECTL) -n $(NAMESPACE) wait --for=condition=Ready scaledobject \
	    -l app.kubernetes.io/managed-by=keda-operator --timeout=60s 2>/dev/null || true; \
	else \
	  echo "      no scaledobject — waiting for deployment rollout..."; \
	  $(KUBECTL) -n $(NAMESPACE) rollout status deployment/iocheck --timeout=120s; \
	fi
	@sleep 3

	# Refresh k6 ConfigMap from disk (in case the script was edited).
	@echo "[2/7] refreshing k6 script ConfigMap..."
	@$(KUBECTL) -n $(NAMESPACE) create configmap k6-script \
	  --from-file=script.js=$(CURDIR)/loadtest/script.js \
	  --dry-run=client -o yaml | $(KUBECTL) apply -f -

	# Kill any prior k6 Job so we can re-run.
	@$(KUBECTL) -n $(NAMESPACE) delete job k6-load --ignore-not-found

	# Start Prometheus + Grafana port-forwards.
	@echo "[3/7] starting port-forwards..."
	@$(call _start_pf,prometheus,9090,9090,$(PROM_NS),prometheus-k8s)
	@$(call _start_pf,grafana,3000,3000,$(PROM_NS),grafana)

	# Wait for metrics-server to publish CPU for every iocheck pod before we
	# start hammering. Without this gate the freshly-created HPA spends its
	# first sync windows in FailedGetResourceMetric ("pods might be unready"),
	# which on a 5-min bench cost us most of the load window before CPU-HPA
	# could react. Polls every 2s up to ~90s.
	@echo "[4/7] warming metrics-server (waiting for kubectl top to report CPU)..."
	@for i in $$(seq 1 45); do \
	  podct=$$($(KUBECTL) -n $(NAMESPACE) get pods -l app=iocheck --no-headers 2>/dev/null | wc -l | tr -d ' '); \
	  topct=$$($(KUBECTL) -n $(NAMESPACE) top pods -l app=iocheck --no-headers 2>/dev/null | awk '$$2 ~ /[0-9]+m/' | wc -l | tr -d ' '); \
	  if [ "$$podct" -gt 0 ] && [ "$$topct" = "$$podct" ]; then \
	    echo "      metrics-server ready ($$topct/$$podct pods, took $$((i*2))s)"; break; \
	  fi; \
	  if [ "$$i" = "45" ]; then \
	    echo "      WARN: metrics-server still partial ($$topct/$$podct) after 90s — proceeding anyway"; \
	  fi; \
	  sleep 2; \
	done

	# Launch the k6 Job with scenario-tagged metrics.
	@testid=$$(date +%Y%m%dT%H%M%SZ); \
	 echo "[5/7] launching k6 (scenario=$(SCENARIO), testid=$$testid, mode=$(MODE), target_rps=$(TARGET_RPS), miss_rate=$(MISS_RATE))..."; \
	 sed -e "s/value: \"unknown\"$$/value: \"$(SCENARIO)\"/" \
	     -e "s/value: \"0\"$$/value: \"$$testid\"/" \
	     -e "s/value: \"1000\"$$/value: \"$(TARGET_RPS)\"/" \
	     -e "s/value: \"-1\"$$/value: \"$(MISS_RATE)\"/" \
	     $(CURDIR)/loadtest/job.yaml | $(KUBECTL) apply -f -

	@echo ""
	@echo "    Grafana: http://localhost:3000/d/iocheck?refresh=5s&from=now-2m&to=now%2B15m"
	@echo "    (anonymous access — no login required)"
	@echo ""

	# Start the capture script in the background; tee k6 logs.
	# ARTIFACT_DIR override: bench-all sets this so all three sub-benches
	# write into a single run dir; standalone bench-* falls back to the
	# legacy <scenario>-<mode>-<ts>/ sibling layout.
	@artdir=$${ARTIFACT_DIR:-artifacts/$(SCENARIO)-$(MODE)-$$(date +%Y%m%dT%H%M%SZ)}; \
	 mkdir -p $$artdir; \
	 echo "[6/7] artifacts → $$artdir"; \
	 ARTIFACT_DIR=$$artdir SCENARIO=$(SCENARIO) PROM_URL=http://localhost:9090 \
	   KUBECTL=$(KUBECTL) MODE=$(MODE) TARGET_RPS=$(TARGET_RPS) MISS_RATE=$(MISS_RATE) \
	   BLACKOUT_AT_S=$(BLACKOUT_AT_S) BLACKOUT_DUR_S=$(BLACKOUT_DUR_S) \
	   bun run $(CURDIR)/scripts/capture.ts > $$artdir/capture.log 2>&1 & \
	 echo $$! > $(PIDS_DIR)/capture.pid; \
	 echo "[7/7] streaming k6 output (Ctrl-C to stop early)..."; \
	 sleep 5; \
	 $(KUBECTL) -n $(NAMESPACE) wait --for=condition=Ready pod -l job-name=k6-load --timeout=60s || true; \
	 if [ -n "$(BLACKOUT_AT_S)" ]; then \
	   echo "      [failure] blackout dance armed: T+$(BLACKOUT_AT_S)s prom→0, T+$$(($(BLACKOUT_AT_S) + $(BLACKOUT_DUR_S)))s restore"; \
	   ( sleep $(BLACKOUT_AT_S); \
	     echo "      [failure] T+$(BLACKOUT_AT_S)s: scaling prometheus to 0"; \
	     $(KUBECTL) patch prometheus k8s -n $(PROM_NS) --type merge -p '{"spec":{"replicas":0}}' >/dev/null; \
	     sleep $(BLACKOUT_DUR_S); \
	     echo "      [failure] T+$$(($(BLACKOUT_AT_S) + $(BLACKOUT_DUR_S)))s: restoring prometheus"; \
	     $(KUBECTL) patch prometheus k8s -n $(PROM_NS) --type merge -p '{"spec":{"replicas":1}}' >/dev/null \
	   ) & \
	   echo $$! > $(PIDS_DIR)/blackout.pid; \
	 fi; \
	 ($(KUBECTL) -n $(NAMESPACE) logs -f -l job-name=k6-load --tail=-1 2>/dev/null | tee $$artdir/k6-stdout.txt) || true; \
	 for i in $$(seq 1 600); do \
	   cond=$$($(KUBECTL) -n $(NAMESPACE) get job k6-load -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type} {end}' 2>/dev/null); \
	   case "$$cond" in \
	     *Complete*) echo "      k6 job: Complete"; break ;; \
	     *Failed*)   echo "      k6 job: Failed (k6 thresholds violated — expected for cold/miss-heavy)"; break ;; \
	   esac; \
	   if [ "$$i" = "600" ]; then echo "      WARN: k6 job did not reach a terminal state after 20m"; fi; \
	   sleep 2; \
	 done; \
	 echo "      dumping per-pod k6 logs (4 pods, kubectl logs -f doesn't aggregate cleanly)..."; \
	 i=0; for pod in $$($(KUBECTL) -n $(NAMESPACE) get pods -l job-name=k6-load -o name 2>/dev/null); do \
	   i=$$((i+1)); \
	   $(KUBECTL) -n $(NAMESPACE) logs $$pod >$$artdir/k6-pod-$$i.txt 2>/dev/null || true; \
	 done; \
	 echo "      observing post-k6 for $(POST_K6_OBSERVE_S)s so KEDA's scale-down lands in the artifact..."; \
	 sleep $(POST_K6_OBSERVE_S); \
	 if [ -f $(PIDS_DIR)/blackout.pid ]; then \
	   pid=$$(cat $(PIDS_DIR)/blackout.pid); wait $$pid 2>/dev/null || true; \
	   rm -f $(PIDS_DIR)/blackout.pid; \
	 fi; \
	 if [ -n "$(BLACKOUT_AT_S)" ]; then \
	   echo "      [failure] safety restore (no-op if already up): patching prometheus replicas=1"; \
	   $(KUBECTL) patch prometheus k8s -n $(PROM_NS) --type merge -p '{"spec":{"replicas":1}}' >/dev/null 2>&1 || true; \
	 fi; \
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
