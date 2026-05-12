import { RedisClient } from "bun";
import type { IOC, IOCType } from "./types";

const url = process.env.REDIS_URL ?? "redis://localhost:56379";

export const cache = new RedisClient(url, {
  connectionTimeout: 5000,
  autoReconnect: true,
  maxRetries: 10,
  enableOfflineQueue: true,
  enableAutoPipelining: true,
});

const HIT_TTL = 300;
const MISS_TTL = 60;
const MISS_SENTINEL = "\x00unknown";

function key(type: IOCType, value: string): string {
  return `ioc:${type}:${value}`;
}

export type Cached = IOC | "unknown" | null;

export async function getCached(type: IOCType, value: string): Promise<Cached> {
  const raw = await cache.get(key(type, value));
  if (raw === null || raw === undefined) return null;
  if (raw === MISS_SENTINEL) return "unknown";
  try {
    return JSON.parse(raw) as IOC;
  } catch {
    // Corrupt entry — treat as miss and let it expire.
    return null;
  }
}

export async function setHit(ioc: IOC): Promise<void> {
  await cache.set(key(ioc.type, ioc.value), JSON.stringify(ioc), "EX", HIT_TTL);
}

export async function setMiss(type: IOCType, value: string): Promise<void> {
  await cache.set(key(type, value), MISS_SENTINEL, "EX", MISS_TTL);
}

export async function invalidate(type: IOCType, value: string): Promise<void> {
  await cache.del(key(type, value));
}

export async function ping(): Promise<boolean> {
  try {
    const res = await cache.send("PING", []);
    return res === "PONG" || res === true;
  } catch {
    return false;
  }
}

export function closeCache(): void {
  cache.close();
}
