import client from "prom-client";

export const registry = new client.Registry();
registry.setDefaultLabels({ service: "iocheck" });

// NOTE: do NOT call client.collectDefaultMetrics() on Bun — it crashes via
// perf_hooks.monitorEventLoopDelay (oven-sh/bun#18300). We expose Bun's
// `server.pendingRequests` directly via the gauge below instead.

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled by iocheck",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const cacheLookupsTotal = new client.Counter({
  name: "cache_lookups_total",
  help: "Cache lookups by result",
  labelNames: ["result"] as const,
  registers: [registry],
});

export const dbQueriesTotal = new client.Counter({
  name: "db_queries_total",
  help: "Database queries by operation",
  labelNames: ["op"] as const,
  registers: [registry],
});

export const inflightRequests = new client.Gauge({
  name: "iocheck_inflight_requests",
  help: "In-flight HTTP requests sampled from Bun.serve.pendingRequests",
  registers: [registry],
});

export function bindInflightSampler(getPending: () => number, intervalMs = 1000): Timer {
  return setInterval(() => inflightRequests.set(getPending()), intervalMs);
}
