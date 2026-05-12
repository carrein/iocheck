import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { tdb, TEST_SCHEMA } from "./setup";
import { RedisClient } from "bun";

// Direct imports of the lookup pipeline. We rebind db + cache to the test
// instances by patching the env before the modules load via dynamic import.
process.env.DATABASE_URL = `${process.env.DATABASE_URL ?? "postgres://iocheck:iocheckdev@localhost:55432/iocheck"}?options=-c%20search_path%3D${TEST_SCHEMA}`;
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:56379";

const { lookup } = await import("../src/lookup");
const cacheMod = await import("../src/cache");

const redisDirect = new RedisClient(process.env.REDIS_URL);

async function flushTestCache() {
  // Wipe only the keys we manage; do not FLUSHALL (might be a shared dev redis).
  for (const k of ["ip:1.2.3.4", "domain:evil.example", "sha256:" + "a".repeat(64)]) {
    await redisDirect.del(`ioc:${k}`);
  }
}

describe("/lookup pipeline", () => {
  beforeAll(async () => {
    await tdb`INSERT INTO iocs (type, value, source, score) VALUES
      ('ip',     '1.2.3.4',         'test-source', 88),
      ('domain', 'evil.example',    'test-source', 72)`;
  });

  afterEach(async () => {
    await flushTestCache();
  });

  test("known IOC returns malicious + payload", async () => {
    const res = await lookup("ip", "1.2.3.4");
    expect(res.verdict).toBe("malicious");
    expect(res.ioc).toBeDefined();
    expect(res.ioc?.value).toBe("1.2.3.4");
    expect(res.ioc?.source).toBe("test-source");
    expect(res.ioc?.score).toBe(88);
  });

  test("unknown IOC returns unknown with no ioc field", async () => {
    const res = await lookup("sha256", "a".repeat(64));
    expect(res.verdict).toBe("unknown");
    expect(res.ioc).toBeUndefined();
  });

  test("second lookup of known IOC hits cache", async () => {
    await lookup("domain", "evil.example"); // first → miss → cache populated
    // Delete the underlying DB row to prove the cache is serving.
    await tdb`DELETE FROM iocs WHERE type = 'domain' AND value = 'evil.example'`;
    const res = await lookup("domain", "evil.example");
    expect(res.verdict).toBe("malicious"); // came from cache, not DB
    // Restore for other tests.
    await tdb`INSERT INTO iocs (type, value, source, score)
      VALUES ('domain','evil.example','test-source',72)
      ON CONFLICT (type, value) DO NOTHING`;
    await cacheMod.invalidate("domain", "evil.example");
  });

  test("unknown lookup caches a tombstone", async () => {
    const v = `unseen-${crypto.randomUUID().slice(0, 8)}.example`;
    const r1 = await lookup("domain", v);
    expect(r1.verdict).toBe("unknown");
    // If we now insert the row, the cache should still serve "unknown"
    // because of the tombstone TTL — until invalidated.
    await tdb`INSERT INTO iocs (type, value, source, score) VALUES ('domain', ${v}, 'late', 50)`;
    const r2 = await lookup("domain", v);
    expect(r2.verdict).toBe("unknown");
    // After invalidation, the next read repopulates from DB.
    await cacheMod.invalidate("domain", v);
    const r3 = await lookup("domain", v);
    expect(r3.verdict).toBe("malicious");
    await tdb`DELETE FROM iocs WHERE type='domain' AND value=${v}`;
    await cacheMod.invalidate("domain", v);
  });
});
