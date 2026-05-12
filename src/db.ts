import { SQL } from "bun";
import type { IOC, IOCType } from "./types";

const url = process.env.DATABASE_URL ?? "postgres://iocheck:iocheckdev@localhost:5432/iocheck";

export const db = new SQL({
  url,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeout: 30,
  connectionTimeout: 10,
});

export async function findIoc(type: IOCType, value: string): Promise<IOC | null> {
  const rows = await db`
    SELECT type, value, source, score, added_at
    FROM iocs
    WHERE type = ${type} AND value = ${value}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return normalize(rows[0] as RawIoc);
}

export async function upsertIoc(ioc: IOC): Promise<IOC> {
  const rows = await db`
    INSERT INTO iocs (type, value, source, score)
    VALUES (${ioc.type}, ${ioc.value}, ${ioc.source}, ${ioc.score})
    ON CONFLICT (type, value) DO UPDATE
      SET source   = EXCLUDED.source,
          score    = EXCLUDED.score,
          added_at = NOW()
    RETURNING type, value, source, score, added_at
  `;
  return normalize(rows[0] as RawIoc);
}

type RawIoc = {
  type: IOCType;
  value: string;
  source: string;
  score: number | string;
  added_at: Date | string;
};

function normalize(r: RawIoc): IOC {
  const added = r.added_at;
  return {
    type: r.type,
    value: r.value,
    source: r.source,
    score: Number(r.score),
    added_at: typeof added === "string" ? added : added.toISOString(),
  };
}

export async function ping(): Promise<boolean> {
  try {
    await db`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await db.close({ timeout: 10 });
}
