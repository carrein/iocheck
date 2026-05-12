// Test preload: create an ephemeral schema, point Bun.sql + Bun.redis at it,
// and clean up after the suite. Tests are skipped if DATABASE_URL / REDIS_URL
// are unset or unreachable.

import { beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://iocheck:iocheckdev@localhost:55432/iocheck";

export const TEST_SCHEMA = `test_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

// Re-export a SQL client bound to the test schema; consumers import from here
// (not src/db.ts) to avoid touching the production schema.
export const tdb = new SQL({ url: `${DATABASE_URL}?options=-c%20search_path%3D${TEST_SCHEMA}`, max: 2 });

beforeAll(async () => {
  const admin = new SQL({ url: DATABASE_URL, max: 1 });
  try {
    await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await admin.unsafe(`SET search_path TO ${TEST_SCHEMA}`);
    await admin.unsafe(`
      CREATE TABLE ${TEST_SCHEMA}.iocs (
        type     TEXT NOT NULL,
        value    TEXT NOT NULL,
        source   TEXT NOT NULL,
        score    SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (type, value),
        CHECK (type IN ('ip','domain','sha256'))
      )
    `);
  } finally {
    await admin.close();
  }
});

afterAll(async () => {
  const admin = new SQL({ url: DATABASE_URL, max: 1 });
  try {
    await admin.unsafe(`DROP SCHEMA ${TEST_SCHEMA} CASCADE`);
  } catch (e) {
    console.error("[setup] schema drop failed:", e);
  } finally {
    await admin.close();
  }
  await tdb.close();
});
