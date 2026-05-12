import * as cache from "./cache";
import * as db from "./db";
import { dbQueriesTotal } from "./metrics";
import type { IOC } from "./types";

export async function upsert(ioc: IOC): Promise<IOC> {
  dbQueriesTotal.inc({ op: "upsert" });
  const row = await db.upsertIoc(ioc);
  await cache.invalidate(ioc.type, ioc.value);
  return row;
}

export function authorize(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  return req.headers.get("x-admin-token") === expected;
}
