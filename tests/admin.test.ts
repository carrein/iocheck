import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { tdb, TEST_SCHEMA } from "./setup";
import { RedisClient } from "bun";

process.env.DATABASE_URL = `${process.env.DATABASE_URL ?? "postgres://iocheck:iocheckdev@localhost:55432/iocheck"}?options=-c%20search_path%3D${TEST_SCHEMA}`;
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";
process.env.ADMIN_TOKEN = "test-token";

const { upsert, authorize } = await import("../src/admin");
const { lookup } = await import("../src/lookup");

const redisDirect = new RedisClient(process.env.REDIS_URL);

describe("/ioc admin", () => {
  beforeAll(async () => {
    // Ensure a clean slate for the test row.
    await tdb`DELETE FROM iocs WHERE type='ip' AND value='9.9.9.9'`;
  });

  afterEach(async () => {
    await redisDirect.del("ioc:ip:9.9.9.9");
  });

  test("authorize requires matching token", () => {
    const ok = new Request("http://x", { headers: { "x-admin-token": "test-token" } });
    const bad = new Request("http://x", { headers: { "x-admin-token": "wrong" } });
    const none = new Request("http://x");
    expect(authorize(ok)).toBe(true);
    expect(authorize(bad)).toBe(false);
    expect(authorize(none)).toBe(false);
  });

  test("upsert inserts then updates the same key", async () => {
    const a = await upsert({ type: "ip", value: "9.9.9.9", source: "src-a", score: 50 });
    expect(a.source).toBe("src-a");
    expect(a.score).toBe(50);
    const b = await upsert({ type: "ip", value: "9.9.9.9", source: "src-b", score: 75 });
    expect(b.source).toBe("src-b");
    expect(b.score).toBe(75);
    const rows = await tdb`SELECT count(*)::int AS n FROM iocs WHERE type='ip' AND value='9.9.9.9'`;
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  test("upsert invalidates the cache for that key", async () => {
    // Seed a stale entry directly in redis.
    await redisDirect.set("ioc:ip:9.9.9.9", JSON.stringify({
      type: "ip", value: "9.9.9.9", source: "stale", score: 1,
    }));
    // First lookup: returns the stale cached value.
    const stale = await lookup("ip", "9.9.9.9");
    expect(stale.ioc?.source).toBe("stale");
    // Upsert with fresh data → should invalidate the cache.
    await upsert({ type: "ip", value: "9.9.9.9", source: "fresh", score: 99 });
    const fresh = await lookup("ip", "9.9.9.9");
    expect(fresh.ioc?.source).toBe("fresh");
    expect(fresh.ioc?.score).toBe(99);
  });
});
