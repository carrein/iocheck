// Bench capture script.
//
// Polls the cluster during a load test and writes a structured artifact
// directory under artifacts/<scenario>-<timestamp>/. Designed to be killed
// (Ctrl-C) at any time — every write is incremental.
//
// Inputs (env):
//   SCENARIO        cpu-hpa | rps-hpa-4 | rps-hpa-8 | failure
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
const MODE = process.env.MODE ?? "miss80";
const TARGET_RPS = process.env.TARGET_RPS ?? "1000";
const MISS_RATE = process.env.MISS_RATE ?? "0.8";
// Blackout knobs (only set for bench-failure). Used to render a dedicated
// summary section showing how the HPA behaved across the Prometheus outage.
const BLACKOUT_AT_S = Number(process.env.BLACKOUT_AT_S ?? "");
const BLACKOUT_DUR_S = Number(process.env.BLACKOUT_DUR_S ?? "");
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
  scaling_active?: string;
  scaling_active_reason?: string;
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

interface PromMultiResponse {
  status: string;
  data?: { result: Array<{ metric: Record<string, string>; value: [number, string] }> };
}

async function promBy(query: string, label: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const url = `${PROM_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
    const r = await fetch(url);
    if (!r.ok) return out;
    const j = (await r.json()) as PromMultiResponse;
    for (const x of j.data?.result ?? []) {
      const key = x.metric[label];
      const v = Number(x.value[1]);
      if (key !== undefined && Number.isFinite(v)) out.set(key, v);
    }
    return out;
  } catch {
    return out;
  }
}

function stats(arr: number[]): { min: number; max: number; mean: number; cv: number } {
  if (arr.length === 0) return { min: 0, max: 0, mean: 0, cv: 0 };
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  const cv = mean > 0 ? (Math.sqrt(variance) / mean) * 100 : 0;
  return { min, max, mean, cv };
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

async function kubectlText(...args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn(KUBECTL, args);
    const chunks: Buffer[] = [];
    p.stdout.on("data", (c: Buffer) => chunks.push(c));
    p.on("close", (code) => {
      if (code !== 0) return resolve(null);
      resolve(Buffer.concat(chunks).toString());
    });
    p.on("error", () => resolve(null));
  });
}

const nodeSamples: Array<{ t: string; node: string; cpu_m: number; cpu_pct: number; mem_mi: number; mem_pct: number }> = [];

async function sampleNodes(): Promise<void> {
  // `kubectl top nodes` output is fixed-width:
  //   NAME  CPU(cores)  CPU(%)  MEMORY(bytes)  MEMORY(%)
  // We parse it as whitespace-separated. This is the same shape metrics-server
  // ships across versions; if the layout ever changes, the row regex below
  // tolerates extra columns by anchoring on the first 5 fields.
  const text = await kubectlText("top", "nodes", "--no-headers");
  if (!text) return;
  const t = new Date().toISOString();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\S+)\s+(\d+)m\s+(\d+)%\s+(\d+)Mi\s+(\d+)%/);
    if (!m) continue;
    nodeSamples.push({
      t, node: m[1]!,
      cpu_m: Number(m[2]), cpu_pct: Number(m[3]),
      mem_mi: Number(m[4]), mem_pct: Number(m[5]),
    });
  }
  await Bun.write(
    `${ARTIFACT_DIR}/node-cpu.csv`,
    "t,node,cpu_m,cpu_pct,mem_mi,mem_pct\n" +
      nodeSamples.map((s) => `${s.t},${s.node},${s.cpu_m},${s.cpu_pct},${s.mem_mi},${s.mem_pct}`).join("\n") +
      "\n",
  );
}

async function sampleOnce(): Promise<void> {
  type Dep = { status?: { readyReplicas?: number; replicas?: number } };
  type HpaList = {
    items: Array<{
      status?: {
        currentReplicas?: number;
        desiredReplicas?: number;
        currentMetrics?: Array<{ external?: { current?: { averageValue?: string; value?: string } } }>;
        conditions?: Array<{ type?: string; status?: string; reason?: string }>;
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
  // ScalingActive condition tracks whether the HPA can read its metric.
  // During the Prometheus blackout (bench-failure) this flips False with
  // reason=FailedGetExternalMetric, then back to True once Prometheus
  // recovers and KEDA's fallback releases the pinned replica count.
  const scalingActiveCond = hpa?.status?.conditions?.find((c) => c.type === "ScalingActive");
  const scalingActive = scalingActiveCond?.status ?? "";
  const scalingActiveReason = scalingActiveCond?.reason ?? "";
  const sample = {
    t: new Date().toISOString(),
    replicas_ready: readyReplicas,
    replicas_desired: replicas,
    hpa_current: current,
    hpa_target: target,
    scaling_active: scalingActive,
    scaling_active_reason: scalingActiveReason,
  };
  samples.push(sample);
  await Bun.write(
    `${ARTIFACT_DIR}/replica-trajectory.csv`,
    "t,replicas_ready,replicas_desired,hpa_current,hpa_target,scaling_active,scaling_active_reason\n" +
      samples.map((s) => `${s.t},${s.replicas_ready},${s.replicas_desired},${s.hpa_current ?? ""},${s.hpa_target ?? ""},${s.scaling_active ?? ""},${s.scaling_active_reason ?? ""}`).join("\n") +
      "\n",
  );
}

async function writeSummary(): Promise<void> {
  const endedAt = new Date();
  const startedS = Math.floor(startedAt.getTime() / 1000);
  const endedS = Math.floor(endedAt.getTime() / 1000);
  const durationS = endedS - startedS;

  // Size the lookback to the actual bench duration. A fixed 15m window
  // over a 5m bench mostly samples empty space — fine for max_over_time
  // (it skips NaN), but avg_over_time was returning NaN because
  // histogram_quantile over empty buckets is NaN and dominated the avg.
  const w = `${Math.max(1, Math.ceil(durationS / 60))}m`;

  const peakRps = await prom(`max_over_time(sum(rate(http_requests_total{service="iocheck"}[1m]))[${w}:15s])`);
  const avgRps = await prom(`avg_over_time(sum(rate(http_requests_total{service="iocheck"}[1m]))[${w}:15s])`);
  // Single p99 over the whole bench window. We deliberately *don't* publish a
  // peak p99 — `max_over_time(... [1m])` catches transient histogram-tail
  // artifacts (scale-up bursts, drain-phase tail) that aren't representative
  // of the workload. One run-window number is the honest headline metric.
  const runP99 = await prom(`histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{service="iocheck",route="/lookup"}[${w}])))`);
  // cadvisor exposes container_cpu_usage_seconds_total via the kubelet target;
  // matching by pod prefix is more robust than the `container` label because
  // some cadvisor variants label it differently. Average per-pod usage as a
  // percentage of the iocheck pod's 300m CPU request.
  const peakCpu = await prom(`max_over_time((100 * avg(rate(container_cpu_usage_seconds_total{namespace="iocheck",pod=~"iocheck-.*",image!=""}[1m])) / 0.3)[${w}:15s])`);
  const avgCpu = await prom(`avg_over_time((100 * avg(rate(container_cpu_usage_seconds_total{namespace="iocheck",pod=~"iocheck-.*",image!=""}[1m])) / 0.3)[${w}:15s])`);
  const peakInflight = await prom(`max_over_time(max(iocheck_inflight_requests{service="iocheck"})[${w}:15s])`);
  // `or vector(0)` so an absent "hit" series (all-miss workloads) yields 0,
  // not null — otherwise the division returns null and the summary renders
  // a bare "-" instead of a real "0.0%".
  const cacheHit = await prom(`(sum(rate(cache_lookups_total{service="iocheck",result="hit"}[${w}])) or vector(0)) / clamp_min(sum(rate(cache_lookups_total{service="iocheck"}[${w}])), 1)`);
  // Non-2xx ratio across the whole bench window. Same `or vector(0)` trick as
  // the cache-hit query — an absent non-2xx series (zero errors, which IS the
  // desirable case) would otherwise make the division return null and render
  // as "-" alongside a "✗" SLO mark, falsely suggesting the metric is broken.
  // Clamp denom to 1 to dodge 0/0 when there's no traffic at all.
  const errorRate = await prom(`(sum(rate(http_requests_total{service="iocheck",status!~"2.."}[${w}])) or vector(0)) / clamp_min(sum(rate(http_requests_total{service="iocheck"}[${w}])), 1)`);
  const totalReqs = await prom(`sum(increase(http_requests_total{service="iocheck"}[${w}]))`);
  // Per-pod RPS + CPU over the last 1 min — Challenge #2 evidence. We want
  // an instant snapshot, not a window average, so the table reflects the
  // load distribution at end-of-bench (after KEDA has scaled out).
  const podRps = await promBy(
    `sum by (pod) (rate(http_requests_total{service="iocheck"}[1m]))`,
    "pod",
  );
  const podCpu = await promBy(
    `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="iocheck",pod=~"iocheck-.*",image!=""}[1m])) * 1000`,
    "pod",
  );

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

  // SLO booleans. Each is a deterministic pass/fail check against the brief.
  // null = "could not measure" — distinct from false ("measured, didn't
  // pass"). This matters for bench-failure: during the Prometheus blackout
  // window the rate() / histogram_quantile() queries return null, and
  // rendering those as ✗ falsely flags the run as an SLO violation when
  // the blackout is itself the test. n/a is the honest answer there.
  const passP99: boolean | null = runP99 === null ? null : runP99 < 0.2;
  const passErrorRate: boolean | null = errorRate === null ? null : errorRate < 0.01;
  // HPA-responded is informational, not pass/fail — the cpu-hpa scenario is
  // EXPECTED to hold at min (that's Challenge #1's whole point). We render
  // ✓/✗ to show what happened; the brief doesn't say "must scale", only
  // "must scale appropriately for the workload".
  const scaled = peakReplicas > minReplicas;

  const fmtMs = (s: number | null) => (s === null ? "-" : `${(s * 1000).toFixed(0)}ms`);
  const fmtPct = (n: number | null) => (n === null ? "-" : `${n.toFixed(1)}%`);
  const fmtNum = (n: number | null, p = 1) => (n === null ? "-" : n.toFixed(p));
  const fmtCount = (n: number | null) => (n === null ? "-" : Math.round(n).toLocaleString());
  const fmtErrPct = (n: number | null) => (n === null ? "-" : `${(n * 100).toFixed(2)}%`);

  // Per-pod table — Challenge #2 evidence. Sorted by pod name for stability
  // across runs; empty pods (no rps and no cpu) are dropped.
  const pods = [...new Set([...podRps.keys(), ...podCpu.keys()])]
    .filter((p) => (podRps.get(p) ?? 0) > 0 || (podCpu.get(p) ?? 0) > 0)
    .sort();
  const rpsStats = stats([...podRps.values()].filter((v) => v > 0));
  const cpuStats = stats([...podCpu.values()].filter((v) => v > 0));
  const perPodSection =
    pods.length === 0
      ? ""
      : `

## Per-pod load distribution (last 1 min)
Evidence for Challenge #2 — kube-proxy iptables round-robins ClusterIP
connections across pods. Low cv% across pods means load is sharing evenly.

| Pod | RPS | CPU (m) |
|-----|----:|--------:|
${pods.map((p) => `| ${p} | ${(podRps.get(p) ?? 0).toFixed(1)} | ${(podCpu.get(p) ?? 0).toFixed(0)} |`).join("\n")}

Spread: RPS cv=${rpsStats.cv.toFixed(1)}% (min ${rpsStats.min.toFixed(1)}, max ${rpsStats.max.toFixed(1)}) · CPU cv=${cpuStats.cv.toFixed(1)}% (min ${cpuStats.min.toFixed(0)}m, max ${cpuStats.max.toFixed(0)}m)`;

  // Node-CPU summary — evidence for whether the cluster's CPU envelope is
  // the binding constraint. Reads what sampleNodes() collected into
  // nodeSamples[]. Peak cpu_pct across all samples × all nodes; if it's
  // pinned near 100% during the bench, infra contention is the ceiling.
  const workerSamples = nodeSamples.filter((s) => /worker/.test(s.node));
  const nodeNames = [...new Set(workerSamples.map((s) => s.node))].sort();
  const peakNodeCpu = workerSamples.length ? Math.max(...workerSamples.map((s) => s.cpu_pct)) : 0;
  const avgNodeCpu = workerSamples.length ? workerSamples.reduce((a, b) => a + b.cpu_pct, 0) / workerSamples.length : 0;
  const nodeSection = nodeNames.length === 0 ? "" : `

## Node-CPU envelope (worker nodes only)
Evidence for whether cluster CPU saturation is the binding constraint —
if worker peak% sits near 100, more iocheck pods can't deliver more RPS
because they're competing with k6 and each other for the same finite cores.

| Node | Peak CPU% | Avg CPU% | Peak mem% |
|------|----------:|---------:|----------:|
${nodeNames.map((n) => {
  const ns = workerSamples.filter((s) => s.node === n);
  const p = Math.max(...ns.map((s) => s.cpu_pct));
  const a = ns.reduce((x, s) => x + s.cpu_pct, 0) / ns.length;
  const m = Math.max(...ns.map((s) => s.mem_pct));
  return `| ${n} | ${p.toFixed(0)}% | ${a.toFixed(0)}% | ${m.toFixed(0)}% |`;
}).join("\n")}

Cluster-wide: peak worker CPU **${peakNodeCpu.toFixed(0)}%**, avg ${avgNodeCpu.toFixed(0)}%.`;

  // Failure-mode section — only rendered if BLACKOUT_AT_S was set. Walks
  // the trajectory samples to find when ScalingActive flipped False/True
  // and what the replica count did across that window. This is the writeup
  // §4 fallback claim, *measured*.
  let failureSection = "";
  if (Number.isFinite(BLACKOUT_AT_S) && BLACKOUT_AT_S > 0) {
    const blackoutStartMs = startedAt.getTime() + BLACKOUT_AT_S * 1000;
    const blackoutEndMs = blackoutStartMs + BLACKOUT_DUR_S * 1000;
    const inBlackout = (s: { t: string }) => {
      const ts = new Date(s.t).getTime();
      return ts >= blackoutStartMs && ts <= blackoutEndMs;
    };
    const beforeBlackout = samples.filter((s) => new Date(s.t).getTime() < blackoutStartMs);
    const duringBlackout = samples.filter(inBlackout);
    const afterBlackout = samples.filter((s) => new Date(s.t).getTime() > blackoutEndMs);
    const repsBefore = beforeBlackout.at(-1)?.replicas_ready ?? "—";
    const repsAtBlackoutEnd = duringBlackout.at(-1)?.replicas_ready ?? "—";
    const repsAfter = afterBlackout.at(-1)?.replicas_ready ?? "—";
    // Find when ScalingActive flipped to False / back to True.
    let scalingActiveFlipFalse: string | undefined;
    let scalingActiveFlipTrue: string | undefined;
    let lastActive = "";
    for (const s of samples) {
      if (s.scaling_active && s.scaling_active !== lastActive) {
        if (s.scaling_active === "False" && !scalingActiveFlipFalse) scalingActiveFlipFalse = s.t;
        if (s.scaling_active === "True" && scalingActiveFlipFalse && !scalingActiveFlipTrue) scalingActiveFlipTrue = s.t;
        lastActive = s.scaling_active;
      }
    }
    const repsMinDuring = duringBlackout.length ? Math.min(...duringBlackout.map((s) => s.replicas_ready)) : 0;
    const repsMaxDuring = duringBlackout.length ? Math.max(...duringBlackout.map((s) => s.replicas_ready)) : 0;
    const blackoutHeld = repsMinDuring === repsMaxDuring;
    failureSection = `

## Fallback behavior (Prometheus blackout T+${BLACKOUT_AT_S}s → T+${BLACKOUT_AT_S + BLACKOUT_DUR_S}s)
Tests writeup §4 — when KEDA loses its metric source, does \`fallback.replicas\`
+ \`behavior: currentReplicasIfHigher\` hold the replica count steady?

- Replicas just before blackout:      **${repsBefore}**
- Replicas range during blackout:     ${repsMinDuring} → ${repsMaxDuring}  (${blackoutHeld ? "**held steady** ✓" : "moved ✗"})
- Replicas at blackout end:           **${repsAtBlackoutEnd}**
- Replicas after blackout (final):    **${repsAfter}**

- ScalingActive flipped False at:     ${scalingActiveFlipFalse ?? "—"}
- ScalingActive recovered True at:    ${scalingActiveFlipTrue ?? "—"}

The "held steady" check is the headline: when Prometheus disappears, KEDA's
fallback should freeze the HPA target at the current replica count rather
than letting it drift or scale to zero.`;
  }

  const md = `# Bench: ${SCENARIO} (${MODE}) @ ${startedAtIso}

Duration: ${durationS}s
Polled every: ${POLL_INTERVAL_S}s
Workload: TARGET_RPS=${TARGET_RPS}, MISS_RATE=${MISS_RATE} (mode=${MODE})

## SLO check
- p99 < 200ms:        ${passP99 === null ? "n/a" : passP99 ? "✓" : "✗"} (${fmtMs(runP99)})
- error rate < 1%:    ${passErrorRate === null ? "n/a" : passErrorRate ? "✓" : "✗"} (${fmtErrPct(errorRate)} of ${fmtCount(totalReqs)} requests)
- HPA scaled:         ${scaled ? "✓" : "✗"} (replicas ${minReplicas === 999 ? "?" : minReplicas} → ${peakReplicas} → ${finalReplicas})

## Key numbers
| Metric              | Value |
|---------------------|-------|
| Peak RPS (cluster)  | ${fmtNum(peakRps)} |
| Avg RPS (cluster)   | ${fmtNum(avgRps)} |
| p99 latency         | ${fmtMs(runP99)} |
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
${perPodSection}${nodeSection}${failureSection}

## Files
- \`replica-trajectory.csv\` — pod count sampled every ${POLL_INTERVAL_S}s
- \`node-cpu.csv\` — per-worker-node CPU% sampled every ${POLL_INTERVAL_S}s
- \`prometheus-snapshots.json\` — captured PromQL series for the test window
- \`hpa-events.txt\` — kubectl describe hpa at end-of-test
- \`k6-stdout.txt\` — full k6 output
`;

  await Bun.write(`${ARTIFACT_DIR}/summary.md`, md);

  // Structured sibling for downstream aggregators (e.g. scripts/compare.ts
  // driven by `make bench-all`). Same numbers as the markdown table; null
  // where the underlying Prometheus query returned no data so a consumer
  // can distinguish "0" from "missing".
  const summaryJson = {
    scenario: SCENARIO,
    mode: MODE,
    target_rps: Number(TARGET_RPS),
    miss_rate: Number(MISS_RATE),
    started_at: startedAtIso,
    ended_at: endedAt.toISOString(),
    duration_s: durationS,
    slo: {
      pass_p99: passP99,
      pass_error_rate: passErrorRate,
      scaled,
    },
    key_numbers: {
      peak_rps: peakRps,
      avg_rps: avgRps,
      p99_s: runP99,
      peak_cpu_pct_request: peakCpu,
      avg_cpu_pct_request: avgCpu,
      peak_inflight_per_pod: peakInflight,
      cache_hit_ratio: cacheHit,
      error_rate: errorRate,
      total_requests: totalReqs,
    },
    replicas: {
      peak: peakReplicas,
      min: minReplicas === 999 ? null : minReplicas,
      final: finalReplicas,
    },
    timeline: {
      scale_up_at: scaleUpAt ?? null,
      scale_up_reached: scaleUpReached ?? null,
      scale_down_at: scaleDownAt ?? null,
    },
  };
  await Bun.write(`${ARTIFACT_DIR}/summary.json`, JSON.stringify(summaryJson, null, 2) + "\n");

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
  // Use the same form as peakCpu above (avg per-pod usage / 0.3-core request).
  // Earlier this divided by kube_pod_container_resource_requests, but KSM
  // reports CPU requests in a different unit than cAdvisor reports usage in
  // this cluster — produced readings of 10,000%+. Hardcoding 0.3 matches the
  // deployment's CPU request and the query the HPA itself uses.
  series.cpu_pct_request = await promRange(
    "100 * avg(rate(container_cpu_usage_seconds_total{namespace=\"iocheck\",pod=~\"iocheck-.*\",image!=\"\"}[1m])) / 0.3",
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
  await Promise.all([sampleOnce(), sampleNodes()]);
  await Bun.sleep(POLL_INTERVAL_S * 1000);
}
