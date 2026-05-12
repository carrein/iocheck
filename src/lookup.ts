import * as cache from "./cache";
import * as db from "./db";
import { cacheLookupsTotal, dbQueriesTotal } from "./metrics";
import type { IOCType, LookupResponse } from "./types";

// Verdict rule: any row in the iocs table counts as "malicious".
// EXERCISE.md does not define a score threshold; the score is metadata.
export async function lookup(type: IOCType, value: string): Promise<LookupResponse> {
  const cached = await cache.getCached(type, value);
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
  const row = await db.findIoc(type, value);
  if (row === null) {
    await cache.setMiss(type, value);
    return { verdict: "unknown" };
  }
  await cache.setHit(row);
  return { verdict: "malicious", ioc: row };
}
