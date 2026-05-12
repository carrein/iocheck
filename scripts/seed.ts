// Seed the iocs table with 10,000 synthetic IOCs.
//
// Distribution:
//   - 100 "hot" IOCs (deterministic values, also referenced by loadtest/script.js)
//     queried in ~90% of load-test traffic → very high cache hit rate
//   - 9,900 "cold" IOCs (random values), queried in ~10% of traffic
//     exercises the miss-path (Postgres) under load
//
// Idempotent: re-running this script does not create duplicates.

import { SQL } from "bun";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://iocheck:iocheckdev@localhost:5432/iocheck";

const HOT_COUNT = 100;
const TOTAL_COUNT = 10_000;
const COLD_COUNT = TOTAL_COUNT - HOT_COUNT;

const TYPES = ["ip", "domain", "sha256"] as const;
type IOCType = (typeof TYPES)[number];
const SOURCES = ["internal-soc", "abuseipdb", "vt", "greynoise", "alienvault"];

function hotValue(i: number): { type: IOCType; value: string } {
  // Deterministic so the loadtest script can target the same keys.
  const type = TYPES[i % TYPES.length]!;
  switch (type) {
    case "ip":
      return { type, value: `10.${(i >> 8) & 0xff}.${i & 0xff}.${(i * 7) & 0xff}` };
    case "domain":
      return { type, value: `hot-${i}.malicious.example` };
    case "sha256":
      return { type, value: `${"0".repeat(56)}${(i * 0x9e3779b1).toString(16).padStart(8, "0")}` };
  }
}

function coldValue(i: number): { type: IOCType; value: string } {
  const type = TYPES[i % TYPES.length]!;
  const r = crypto.randomUUID().replace(/-/g, "");
  switch (type) {
    case "ip": {
      const a = Number.parseInt(r.slice(0, 2), 16);
      const b = Number.parseInt(r.slice(2, 4), 16);
      const c = Number.parseInt(r.slice(4, 6), 16);
      const d = Number.parseInt(r.slice(6, 8), 16);
      return { type, value: `${a}.${b}.${c}.${d}` };
    }
    case "domain":
      return { type, value: `cold-${r.slice(0, 12)}.example` };
    case "sha256":
      return { type, value: `${r}${r}` };
  }
}

async function main() {
  const db = new SQL({ url: DATABASE_URL, max: 5, idleTimeout: 30, connectionTimeout: 30 });
  console.log(`[seed] connecting to ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);
  // Wait for Postgres to accept connections — the Job init container handles
  // wait-for-pg, but this is a belt-and-suspenders retry in case of races.
  for (let i = 0; i < 30; i++) {
    try {
      await db`SELECT 1`;
      break;
    } catch {
      if (i === 29) throw new Error("postgres unreachable after 30s");
      await Bun.sleep(1000);
    }
  }

  const records: Array<{ type: IOCType; value: string; source: string; score: number }> = [];
  for (let i = 0; i < HOT_COUNT; i++) {
    const { type, value } = hotValue(i);
    records.push({
      type,
      value,
      source: SOURCES[i % SOURCES.length]!,
      score: 50 + (i % 51),
    });
  }
  for (let i = 0; i < COLD_COUNT; i++) {
    const { type, value } = coldValue(i);
    records.push({
      type,
      value,
      source: SOURCES[i % SOURCES.length]!,
      score: 30 + (i % 71),
    });
  }

  // Bulk insert in chunks for memory friendliness on small pods.
  const CHUNK = 1000;
  let inserted = 0;
  const t0 = performance.now();
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    const result = await db`
      INSERT INTO iocs ${db(chunk, "type", "value", "source", "score")}
      ON CONFLICT (type, value) DO NOTHING
    `;
    inserted += (result as { count?: number }).count ?? chunk.length;
  }
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`[seed] inserted ${inserted}/${records.length} rows in ${ms}ms (hot=${HOT_COUNT}, cold=${COLD_COUNT})`);

  // Write the hot keys to a file the loadtest ConfigMap can read.
  // (When running in-cluster as a Job, this path is ignored.)
  const outPath = process.env.HOT_KEYS_OUT;
  if (outPath) {
    const hot = Array.from({ length: HOT_COUNT }, (_, i) => hotValue(i));
    await Bun.write(outPath, JSON.stringify(hot, null, 2));
    console.log(`[seed] hot keys written to ${outPath}`);
  }

  await db.close();
}

main().catch((e) => {
  console.error("[seed] failed:", e);
  process.exit(1);
});
