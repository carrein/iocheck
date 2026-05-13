// Aggregates per-bench summary.json files into a single comparison.md.
//
// Driven by `make bench-all`, which lays out:
//   artifacts/bench-all-<ts>/
//     cpu-hpa/summary.json
//     rps-hpa-4/summary.json
//     rps-hpa-8/summary.json
// and runs us with the run root as argv[2]. We read the three summary.json
// files (skipping any that are missing — those benches failed before
// capture.ts could write its summary) and emit comparison.md next to them.
//
// The script is intentionally Bun-only and depends on nothing outside the
// project: no markdown libs, no template engines. The output format is
// fixed by hand-written template strings.

const SCENARIOS = ["cpu-hpa", "rps-hpa-4", "rps-hpa-8"] as const;
type Scenario = (typeof SCENARIOS)[number];

interface Summary {
  scenario: string;
  mode: string;
  target_rps: number;
  miss_rate: number;
  started_at: string;
  duration_s: number;
  slo: { pass_p99: boolean; pass_error_rate: boolean; scaled: boolean };
  key_numbers: {
    peak_rps: number | null;
    avg_rps: number | null;
    p99_s: number | null;
    error_rate: number | null;
    total_requests: number | null;
  };
  replicas: { peak: number; min: number | null; final: number };
}

const runRoot = process.argv[2];
if (!runRoot) {
  console.error("usage: bun run scripts/compare.ts <bench-all-run-root>");
  process.exit(2);
}

interface Row {
  scenario: Scenario;
  loaded: Summary | null;
}

const rows: Row[] = [];
for (const scenario of SCENARIOS) {
  const path = `${runRoot}/${scenario}/summary.json`;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    rows.push({ scenario, loaded: null });
    continue;
  }
  try {
    const loaded = (await file.json()) as Summary;
    rows.push({ scenario, loaded });
  } catch (err) {
    console.error(`[compare] failed to parse ${path}: ${err}`);
    rows.push({ scenario, loaded: null });
  }
}

const fmtMs = (s: number | null) => (s == null ? "—" : `${(s * 1000).toFixed(0)}ms`);
const fmtErrPct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(2)}%`);
const fmtMark = (b: boolean | undefined) => (b ? "✓" : "✗");

const succeeded = rows.filter((r) => r.loaded !== null);
const failed = rows.filter((r) => r.loaded === null);
const anyFailed = failed.length > 0;

// Pull workload from the first successful row (all three share the same
// MISS_RATE / TARGET_RPS — bench-all forwards them identically).
const ref = succeeded[0]?.loaded;
const workloadLine = ref
  ? `Workload: TARGET_RPS=${ref.target_rps}, MISS_RATE=${ref.miss_rate} (mode=${ref.mode})`
  : "Workload: (no successful benches — workload metadata unavailable)";

// Headline table. Per-row "summary" cell links to that bench's summary.md
// via a relative path (the .md lives in artifacts/bench-all-<ts>/, so
// `<scenario>/summary.md` resolves to the sibling subdir).
const tableHeader =
  "| Scenario | p99 | Error rate | Peak replicas | p99<200ms | err<1% | scaled | Details |\n" +
  "|----------|----:|-----------:|--------------:|:---------:|:------:|:------:|---------|";

const tableRows = rows
  .map((row) => {
    const link = `[${row.scenario}/summary.md](./${row.scenario}/summary.md)`;
    if (!row.loaded) {
      return `| ${row.scenario} | — | — | — | ✗ | ✗ | ✗ | ${link} (failed — no summary.json) |`;
    }
    const s = row.loaded;
    return (
      `| ${row.scenario} ` +
      `| ${fmtMs(s.key_numbers.p99_s)} ` +
      `| ${fmtErrPct(s.key_numbers.error_rate)} ` +
      `| ${s.replicas.peak} ` +
      `| ${fmtMark(s.slo.pass_p99)} ` +
      `| ${fmtMark(s.slo.pass_error_rate)} ` +
      `| ${fmtMark(s.slo.scaled)} ` +
      `| ${link} |`
    );
  })
  .join("\n");

const failureNote = anyFailed
  ? `\n\n> ⚠ ${failed.length}/${SCENARIOS.length} bench(es) failed: ${failed
      .map((f) => f.scenario)
      .join(", ")}.\n`
  : "";

const md = `# Bench comparison

${workloadLine}
Generated: ${new Date().toISOString()}

${tableHeader}
${tableRows}
${failureNote}
Per-bench details: click any scenario's link above for the full \`summary.md\`
(raw trajectories live in the same subdir).
`;

await Bun.write(`${runRoot}/comparison.md`, md);
console.log(`[compare] wrote ${runRoot}/comparison.md`);
console.log("\n" + md);

// Exit non-zero if any bench failed, so `make bench-all` propagates the
// status. bench-all also tracks per-scenario rc, so this is belt-and-braces.
process.exit(anyFailed ? 1 : 0);

export {};
