// k6 load script for iocheck.
//
// Profile (open model — ramping-arrival-rate):
//   00:00 → 00:30   ramp 0 → TARGET_RPS (baseline)
//   00:30 → 02:30   sustained TARGET_RPS (10x burst, matches EXERCISE.md)
//   02:30 → 05:00   drain TARGET_RPS → 0
//
// Why ramping-arrival-rate (not ramping-vus): we want to drive a fixed
// throughput regardless of how fast each request returns. With VUs, slow
// responses cap our actual RPS — which would mask the very latency
// degradation we're trying to surface.
//
// Env knobs:
//   TARGET_RPS    sustained RPS during the plateau (default 1000)
//   CACHE_BUSTER  when "1", every request is a random IOC → 100% cache
//                 miss, 100% DB miss. Use to put I/O pressure on pods
//                 without driving CPU up (the regime that exposes
//                 CPU-HPA's structural blindness on async workloads).
//
// Default hot/cold mix (CACHE_BUSTER unset):
//   90% of requests hit one of 100 "hot" IOCs (deterministic values
//        also produced by scripts/seed.ts → near-perfect cache hits)
//   10% of requests hit "cold" IOCs (random values, miss path → DB)

import http from "k6/http";
import { check } from "k6";

const TARGET_HOST = __ENV.TARGET_HOST || "http://iocheck.iocheck.svc:80";
// TARGET_RPS is the CLUSTER-WIDE target; each parallel k6 pod drives a share.
const TARGET_RPS_TOTAL = Number(__ENV.TARGET_RPS || 1000);
const PARALLELISM = Math.max(1, Number(__ENV.PARALLELISM || 1));
const TARGET_RPS = Math.ceil(TARGET_RPS_TOTAL / PARALLELISM);
const CACHE_BUSTER = __ENV.CACHE_BUSTER === "1";

export const options = {
  discardResponseBodies: true,
  // Disable HTTP keep-alive. kube-proxy iptables mode load-balances at
  // TCP-connect time; reused connections pin all subsequent requests to
  // whichever pod was picked when the connection opened. Without this, pods
  // that the HPA adds mid-bench receive ~0 traffic because all VUs are
  // already attached to the original pods. Verified empirically: enabling
  // reuse left 8/10 RPS-HPA replicas idle while 2 absorbed all load.
  noConnectionReuse: true,
  scenarios: {
    load: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      // Scale VU pools with TARGET_RPS so high-RPS cold runs (where
      // per-request latency is higher) don't starve for VUs.
      preAllocatedVUs: Math.max(200, Math.ceil(TARGET_RPS * 0.3)),
      maxVUs: Math.max(500, Math.ceil(TARGET_RPS * 0.8)),
      stages: [
        { duration: "30s", target: TARGET_RPS },
        { duration: "2m", target: TARGET_RPS },
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
  const target = CACHE_BUSTER
    ? randomCold()
    : Math.random() < 0.9
    ? HOT[Math.floor(Math.random() * HOT.length)]
    : randomCold();
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
