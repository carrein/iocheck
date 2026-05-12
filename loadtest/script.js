// k6 load script for iocheck.
//
// Profile (open model — ramping-arrival-rate):
//   00:00 → 01:00   ramp 0 → 100 RPS (baseline)
//   01:00 → 05:00   sustained 1000 RPS (10x burst, matches EXERCISE.md)
//   05:00 → 10:00   drain 1000 → 0 RPS
//
// Why ramping-arrival-rate (not ramping-vus): we want to drive a fixed
// throughput regardless of how fast each request returns. With VUs, slow
// responses cap our actual RPS — which would mask the very latency
// degradation we're trying to surface.
//
// Hot/cold distribution:
//   90% of requests hit one of 100 "hot" IOCs (deterministic values
//        also produced by scripts/seed.ts → near-perfect cache hits)
//   10% of requests hit "cold" IOCs (random values, miss path → DB)

import http from "k6/http";
import { check } from "k6";

const TARGET_HOST = __ENV.TARGET_HOST || "http://iocheck.iocheck.svc:80";

export const options = {
  discardResponseBodies: true,
  scenarios: {
    load: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 500,
      stages: [
        { duration: "30s", target: 1000 },
        { duration: "2m", target: 1000 },
        { duration: "2m30s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{expected_response:true}": ["p(99)<200"],
  },
  // Tag every metric with the scenario name so Prometheus can split runs.
  tags: { scenario: __ENV.SCENARIO || "unknown" },
};

const TYPES = ["ip", "domain", "sha256"];

function hotValue(i) {
  const type = TYPES[i % TYPES.length];
  if (type === "ip") {
    return { type, value: `10.${(i >> 8) & 0xff}.${i & 0xff}.${(i * 7) & 0xff}` };
  }
  if (type === "domain") {
    return { type, value: `hot-${i}.malicious.example` };
  }
  // sha256
  let suffix = (i * 0x9e3779b1).toString(16);
  while (suffix.length < 8) suffix = "0" + suffix;
  return { type, value: "0".repeat(56) + suffix };
}

const HOT = [];
for (let i = 0; i < 100; i++) HOT.push(hotValue(i));

function randomCold() {
  // Hex string for sha256 / random domain. Lookup will miss.
  const hex = Math.random().toString(16).slice(2).padEnd(16, "0");
  const r = Math.random();
  if (r < 0.33) {
    return { type: "ip", value: `203.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}` };
  }
  if (r < 0.66) {
    return { type: "domain", value: `cold-${hex}.example` };
  }
  return { type: "sha256", value: (hex + hex + hex + hex).slice(0, 64) };
}

export default function () {
  const target = Math.random() < 0.9 ? HOT[Math.floor(Math.random() * HOT.length)] : randomCold();
  const res = http.post(
    `${TARGET_HOST}/lookup`,
    JSON.stringify(target),
    { headers: { "content-type": "application/json" }, tags: { route: "/lookup" } },
  );
  check(res, { "status 200": (r) => r.status === 200 });
}

export function handleSummary(data) {
  // Drop a JSON summary file the capture script can read.
  return {
    "/artifacts/k6-summary.json": JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  };
}

function textSummary(data) {
  const m = data.metrics || {};
  const v = (key, stat = "values") => (m[key] && m[key][stat] ? m[key][stat] : undefined);
  const reqs = v("http_reqs", "values") || {};
  const dur = v("http_req_duration") || {};
  const fail = v("http_req_failed") || {};
  const fmt = (x) => (typeof x === "number" ? x.toFixed(2) : "-");
  return [
    "=== k6 summary ===",
    `requests:     ${fmt(reqs.count)} (${fmt(reqs.rate)} RPS avg)`,
    `failed rate:  ${fmt((fail.rate || 0) * 100)}%`,
    `p50 latency:  ${fmt(dur["p(50)"])} ms`,
    `p95 latency:  ${fmt(dur["p(95)"])} ms`,
    `p99 latency:  ${fmt(dur["p(99)"])} ms`,
    `max latency:  ${fmt(dur.max)} ms`,
    "==================",
    "",
  ].join("\n");
}
