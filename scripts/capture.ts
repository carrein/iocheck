// Bench capture script.
//
// Polls the cluster during a load test and writes a structured artifact
// directory under artifacts/<scenario>-<timestamp>/. Designed to be killed
// (Ctrl-C) at any time — every write is incremental.
//
// Inputs (env):
//   SCENARIO        cpu-hpa | rps-hpa
//   ARTIFACT_DIR    target dir (created if missing)
//   PROM_URL        Prometheus base URL (default http://localhost:9090)
//   POLL_INTERVAL_S sampling cadence (default 5)
//   KUBECTL         path to kubectl binary (default kubectl)
//
// Lifecycle:
//   1. Sample every POLL_INTERVAL_S → append to state.csv
//   2. On SIGINT/SIGTERM (or natural exit), query Prometheus for summary
//      windows and write summary.md + prometheus-snapshots.json
//   3. Exit 0

import { spawn } from "node:child_process";

const SCENARIO = process.env.SCENARIO ?? "unknown";
const ARTIFACT_DIR = process.env.ARTIFACT_DIR ?? `artifacts/${SCENARIO}-${Date.now()}`;
const PROM_URL = process.env.PROM_URL ?? "http://localhost:9090";
const POLL_INTERVAL_S = Number(process.env.POLL_INTERVAL_S ?? 5);
const KUBECTL = process.env.KUBECTL ?? "kubectl";
const NAMESPACE = "iocheck";
const DEPLOYMENT = "iocheck";

await Bun.$`mkdir -p ${ARTIFACT_DIR}`.quiet();
console.log(`[capture] writing to ${ARTIFACT_DIR}`);

const startedAt = new Date();
const startedAtIso = startedAt.toISOString();
const samples: Array<{
  t: string;
  replicas_ready: number;
  replicas_desired: number;
  hpa_current?: string;
  hpa_target?: string;
}> = [];

interface PromResponse {
  status: string;
  data?: { result: Array<{ value: [number, string] }> };
}

async function prom(query: string): Promise<number | null> {
  try {
    const url = `${PROM_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = (await r.json()) as PromResponse;
    if (!j.data?.result.length) return null;
    const v = j.data.result[0]?.value?.[1];
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function promRange(query: string, startS: number, endS: number, stepS: number): Promise<unknown> {
  try {
    const url = new URL(`${PROM_URL}/api/v1/query_range`);
    url.searchParams.set("query", query);
    url.searchParams.set("start", String(startS));
    url.searchParams.set("end", String(endS));
    url.searchParams.set("step", String(stepS));
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function kubectlJson<T>(...args: string[]): Promise<T | null> {
  return new Promise((resolve) => {
    const p = spawn(KUBECTL, [...args, "-o", "json"]);
    const chunks: Buffer[] = [];
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.on("close", (code) => {
      if (code !== 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(null);
      }
    });
    p.on("error", () => resolve(null));
  });
}

async function sampleOnce(): Promise<void> {
  type Dep = { status?: { readyReplicas?: number; replicas?: number } };
  type HpaList = {
    items: Array<{
      status?: {
        currentReplicas?: number;
        desiredReplicas?: number;
        currentMetrics?: Array<{ external?: { current?: { averageValue?: string; value?: string } } }>;
      };
      spec?: {
        metrics?: Array<{ external?: { target?: { averageValue?: string; value?: string } } }>;
      };
    }>;
  };
  const dep = await kubectlJson<Dep>("get", "deploy", DEPLOYMENT, "-n", NAMESPACE);
  const hpas = await kubectlJson<HpaList>("get", "hpa", "-n", NAMESPACE);
  const readyReplicas = dep?.status?.readyReplicas ?? 0;
  const replicas = dep?.status?.replicas ?? 0;
  const hpa = hpas?.items[0];
  const current =
    hpa?.status?.currentMetrics?.[0]?.external?.current?.averageValue ??
    hpa?.status?.currentMetrics?.[0]?.external?.current?.value ??
    String(hpa?.status?.currentReplicas ?? "");
  const target =
    hpa?.spec?.metrics?.[0]?.external?.target?.averageValue ??
    hpa?.spec?.metrics?.[0]?.external?.target?.value ??
    "";
  const sample = {
    t: new Date().toISOString(),
    replicas_ready: readyReplicas,
    replicas_desired: replicas,
    hpa_current: current,
    hpa_target: target,
  };
  samples.push(sample);
  await Bun.write(
    `${ARTIFACT_DIR}/replica-trajectory.csv`,
    "t,replicas_ready,replicas_desired,hpa_current,hpa_target\n" +
      samples.map((s) => `${s.t},${s.replicas_ready},${s.replicas_desired},${s.hpa_current ?? ""},${s.hpa_target ?? ""}`).join("\n") +
      "\n",
  );
}

async function writeSummary(): Promise<void> {
  const endedAt = new Date();
  const startedS = Math.floor(startedAt.getTime() / 1000);
  const endedS = Math.floor(endedAt.getTime() / 1000);
  const durationS = endedS - startedS;

  const peakRps = await prom("max_over_time(sum(rate(http_requests_total{service=\"iocheck\"}[1m]))[15m:15s])");
  const avgRps = await prom("avg_over_time(sum(rate(http_requests_total{service=\"iocheck\"}[1m]))[15m:15s])");
  const peakP99 = await prom("max_over_time(histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{service=\"iocheck\",route=\"/lookup\"}[1m])))[15m:15s])");
  const avgP99 = await prom("avg_over_time(histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{service=\"iocheck\",route=\"/lookup\"}[1m])))[15m:15s])");
  // cadvisor exposes container_cpu_usage_seconds_total via the kubelet target;
  // matching by pod prefix is more robust than the `container` label because
  // some cadvisor variants label it differently. Average per-pod usage as a
  // percentage of the iocheck pod's 300m CPU request.
  const peakCpu = await prom("max_over_time((100 * avg(rate(container_cpu_usage_seconds_total{namespace=\"iocheck\",pod=~\"iocheck-.*\",image!=\"\"}[1m])) / 0.3)[15m:15s])");
  const avgCpu = await prom("avg_over_time((100 * avg(rate(container_cpu_usage_seconds_total{namespace=\"iocheck\",pod=~\"iocheck-.*\",image!=\"\"}[1m])) / 0.3)[15m:15s])");
  const peakInflight = await prom("max_over_time(max(iocheck_inflight_requests{service=\"iocheck\"})[15m:15s])");
  const cacheHit = await prom("sum(rate(cache_lookups_total{service=\"iocheck\",result=\"hit\"}[15m])) / sum(rate(cache_lookups_total{service=\"iocheck\"}[15m]))");

  const peakReplicas = Math.max(...samples.map((s) => s.replicas_ready), 0);
  const minReplicas = Math.min(...samples.map((s) => s.replicas_ready), 999);
  const finalReplicas = samples.at(-1)?.replicas_ready ?? 0;

  // Find scale-up start: first sample where replicas > min.
  let scaleUpAt: string | undefined;
  let scaleUpReached: string | undefined;
  let scaleDownAt: string | undefined;
  for (const s of samples) {
    if (!scaleUpAt && s.replicas_ready > minReplicas) scaleUpAt = s.t;
    if (!scaleUpReached && s.replicas_ready === peakReplicas && peakReplicas > minReplicas) scaleUpReached = s.t;
    if (scaleUpReached && !scaleDownAt && s.replicas_ready < peakReplicas) scaleDownAt = s.t;
  }

  const errorBudget = peakP99 !== null && peakP99 < 0.2;
  const scaled = peakReplicas > minReplicas;
  const verdict: string[] = [];
  verdict.push(errorBudget ? "✅ p99 < 200ms target met" : "❌ p99 < 200ms NOT met");
  verdict.push(scaled ? `✅ Replicas scaled ${minReplicas} → ${peakReplicas} → ${finalReplicas}` : `❌ HPA did not scale (held at ${peakReplicas})`);

  const fmtMs = (s: number | null) => (s === null ? "-" : `${(s * 1000).toFixed(0)}ms`);
  const fmtPct = (n: number | null) => (n === null ? "-" : `${n.toFixed(1)}%`);
  const fmtNum = (n: number | null, p = 1) => (n === null ? "-" : n.toFixed(p));

  const md = `# Bench: ${SCENARIO} @ ${startedAtIso}

Duration: ${durationS}s
Polled every: ${POLL_INTERVAL_S}s

## Verdict
${verdict.map((v) => `- ${v}`).join("\n")}

## Key numbers
| Metric              | Value |
|---------------------|-------|
| Peak RPS (cluster)  | ${fmtNum(peakRps)} |
| Avg RPS (cluster)   | ${fmtNum(avgRps)} |
| Peak p99 latency    | ${fmtMs(peakP99)} |
| Avg p99 latency     | ${fmtMs(avgP99)} |
| Peak CPU %req       | ${fmtPct(peakCpu)} |
| Avg CPU %req        | ${fmtPct(avgCpu)} |
| Peak in-flight/pod  | ${fmtNum(peakInflight, 0)} |
| Cache hit rate      | ${cacheHit === null ? "-" : (cacheHit * 100).toFixed(1) + "%"} |
| Peak replicas       | ${peakReplicas} |
| Min replicas        | ${minReplicas === 999 ? "-" : minReplicas} |
| Final replicas      | ${finalReplicas} |

## Scaling timeline
- Bench start:         ${startedAtIso}
- Scale-up began:      ${scaleUpAt ?? "—"}
- Peak reached:        ${scaleUpReached ?? "—"}
- Scale-down began:    ${scaleDownAt ?? "—"}
- Final sample:        ${samples.at(-1)?.t ?? "—"}

## Files
- \`replica-trajectory.csv\` — pod count sampled every ${POLL_INTERVAL_S}s
- \`prometheus-snapshots.json\` — captured PromQL series for the test window
- \`hpa-events.txt\` — kubectl describe hpa at end-of-test
- \`k6-stdout.txt\` — full k6 output
`;

  await Bun.write(`${ARTIFACT_DIR}/summary.md`, md);

  // Save range queries for the test window.
  const series: Record<string, unknown> = {};
  series.rps = await promRange(
    "sum(rate(http_requests_total{service=\"iocheck\"}[1m]))",
    startedS, endedS, POLL_INTERVAL_S,
  );
  series.p99 = await promRange(
    "histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{service=\"iocheck\",route=\"/lookup\"}[1m])))",
    startedS, endedS, POLL_INTERVAL_S,
  );
  series.cpu_pct_request = await promRange(
    "100 * sum(rate(container_cpu_usage_seconds_total{namespace=\"iocheck\",container=\"iocheck\"}[1m])) / sum(kube_pod_container_resource_requests{namespace=\"iocheck\",container=\"iocheck\",resource=\"cpu\"})",
    startedS, endedS, POLL_INTERVAL_S,
  );
  // Replica trajectory is already in replica-trajectory.csv from kubectl polling;
  // the Prometheus version (kube-state-metrics-backed) is here for cross-check.
  series.replicas = await promRange(
    "kube_deployment_spec_replicas{namespace=\"iocheck\",deployment=\"iocheck\"}",
    startedS, endedS, POLL_INTERVAL_S,
  );
  series.inflight_per_pod = await promRange(
    "avg(iocheck_inflight_requests{service=\"iocheck\"})",
    startedS, endedS, POLL_INTERVAL_S,
  );
  await Bun.write(`${ARTIFACT_DIR}/prometheus-snapshots.json`, JSON.stringify(series, null, 2));

  // Capture HPA describe at end-of-test.
  try {
    const proc = Bun.spawn([KUBECTL, "describe", "hpa", "-n", NAMESPACE], {
      stdout: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await Bun.write(`${ARTIFACT_DIR}/hpa-events.txt`, text);
  } catch {
    /* ignore */
  }

  console.log(`\n[capture] wrote ${ARTIFACT_DIR}/summary.md`);
  console.log("\n" + md);
}

let polling = true;
const stop = async (sig: string) => {
  if (!polling) return;
  polling = false;
  console.log(`\n[capture] received ${sig}; writing summary...`);
  await writeSummary();
  process.exit(0);
};
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

while (polling) {
  await sampleOnce();
  await Bun.sleep(POLL_INTERVAL_S * 1000);
}
