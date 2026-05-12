import { describe, expect, test } from "bun:test";

const { registry, httpRequestsTotal, cacheLookupsTotal } = await import("../src/metrics");

describe("metrics", () => {
  test("registry emits Prometheus text exposition", async () => {
    const body = await registry.metrics();
    expect(body).toContain("# HELP http_requests_total");
    expect(body).toContain("# TYPE http_requests_total counter");
    expect(registry.contentType).toContain("text/plain");
  });

  test("counters increment", async () => {
    httpRequestsTotal.inc({ method: "POST", route: "/lookup", status: "200" });
    httpRequestsTotal.inc({ method: "POST", route: "/lookup", status: "200" });
    const metric = await httpRequestsTotal.get();
    const sample = metric.values.find(
      (v) => v.labels.method === "POST" && v.labels.route === "/lookup" && v.labels.status === "200",
    );
    expect(sample?.value).toBeGreaterThanOrEqual(2);
  });

  test("cache_lookups_total has hit/miss/unknown labels", async () => {
    cacheLookupsTotal.inc({ result: "hit" });
    cacheLookupsTotal.inc({ result: "miss" });
    cacheLookupsTotal.inc({ result: "unknown" });
    const metric = await cacheLookupsTotal.get();
    const labels = new Set(metric.values.map((v) => String(v.labels.result)));
    expect(labels.has("hit")).toBe(true);
    expect(labels.has("miss")).toBe(true);
    expect(labels.has("unknown")).toBe(true);
  });
});
