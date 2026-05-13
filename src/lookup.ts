import * as cache from "./cache";
import * as db from "./db";
import { cacheLookupsTotal, dbQueriesTotal, lookupStepDuration } from "./metrics";
import type { IOCType, LookupResponse } from "./types";

// Any row in the iocs table is malicious; score is operator metadata, not threshold logic.
export async function lookup(type: IOCType, value: string): Promise<LookupResponse> {
  const tGetStart = performance.now();
  const cached = await cache.getCached(type, value);
  lookupStepDuration.observe({ step: "cache_get" }, (performance.now() - tGetStart) / 1000);
  if (cached === "unknown") {
    cacheLookupsTotal.inc({ result: "unknown" });
    return { verdict: "unknown" };
  }
  if (cached !== null) {
    cacheLookupsTotal.inc({ result: "hit" });
    return { verdict: "malicious", ioc: cached };
  }
  cacheLookupsTotal.inc({ result: "miss" });
  dbQueriesTotal.inc({ op: "find" });
  const tDbStart = performance.now();
  const row = await db.findIoc(type, value);
  lookupStepDuration.observe({ step: "pg_find" }, (performance.now() - tDbStart) / 1000);
  const tSetStart = performance.now();
  if (row === null) {
    await cache.setMiss(type, value);
    lookupStepDuration.observe({ step: "cache_set" }, (performance.now() - tSetStart) / 1000);
    return { verdict: "unknown" };
  }
  await cache.setHit(row);
  lookupStepDuration.observe({ step: "cache_set" }, (performance.now() - tSetStart) / 1000);
  return { verdict: "malicious", ioc: row };
}
