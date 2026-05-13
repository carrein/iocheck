// k6 load script for iocheck.
//
// Profile (open model — ramping-arrival-rate):
//   00:00 → 00:30   ramp 0 → TARGET_RPS (baseline)
//   00:30 → 02:00   sustained TARGET_RPS (90s plateau — long enough for
//                   the slowest autoscaler (CPU-HPA, ~80s to first scale)
//                   to react and for the faster RPS scalers to land a
//                   distinguishable steady-state p99 reading)
//   02:00 → 02:30   drain TARGET_RPS → 0 (fast — pushes per-pod RPS below
//                   KEDA's threshold quickly so the post-k6 observation
//                   window can witness scale-down kicking off)
//
// Why ramping-arrival-rate (not ramping-vus): we want to drive a fixed
// throughput regardless of how fast each request returns. With VUs, slow
// responses cap our actual RPS — which would mask the very latency
// degradation we're trying to surface.
//
// Env knobs:
//   TARGET_RPS    sustained RPS during the plateau (default 1000)
//   MISS_RATE     0..1, fraction of requests that hit a random (uncached)
//                 IOC and so traverse the cache-miss → DB path. The
//                 remainder hit one of 100 deterministic "hot" IOCs the
//                 seed job inserts → near-perfect cache hit.
//                   0.1            → realistic 90/10 hit/miss
//                   0.8 (default)  → 80% miss / 20% hot (stress mix)
//                   1              → all-miss DB-saturation probe

import http from "k6/http";
import { check } from "k6";

const TARGET_HOST = __ENV.TARGET_HOST || "http://iocheck.iocheck.svc:80";
// TARGET_RPS is the CLUSTER-WIDE target; each parallel k6 pod drives a share.
const TARGET_RPS_TOTAL = Number(__ENV.TARGET_RPS || 1000);
const PARALLELISM = Math.max(1, Number(__ENV.PARALLELISM || 1));
const TARGET_RPS = Math.ceil(TARGET_RPS_TOTAL / PARALLELISM);
const MISS_RATE_RAW = Number(__ENV.MISS_RATE);
const MISS_RATE = Number.isFinite(MISS_RATE_RAW) && MISS_RATE_RAW >= 0 && MISS_RATE_RAW <= 1
  ? MISS_RATE_RAW
  : 0.8;

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
        { duration: "30s",  target: TARGET_RPS },
        { duration: "1m30s", target: TARGET_RPS },
        { duration: "30s",  target: 0 },
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
  const target = Math.random() < MISS_RATE
    ? randomCold()
    : HOT[Math.floor(Math.random() * HOT.length)];
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
