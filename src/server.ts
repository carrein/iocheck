import * as cache from "./cache";
import * as db from "./db";
import { upsert, authorize } from "./admin";
import { lookup } from "./lookup";
import { IOC_TYPES, isIOCType } from "./types";
import {
  bindInflightSampler,
  httpRequestDuration,
  httpRequestsTotal,
  registry,
} from "./metrics";
import { installShutdownHandler } from "./shutdown";

const PORT = Number(process.env.PORT ?? 3000);

let isReady = false;
let readyzCache = { ok: false, at: 0 };
const READYZ_TTL_MS = 1000;

async function checkReady(): Promise<boolean> {
  const now = Date.now();
  if (now - readyzCache.at < READYZ_TTL_MS) return readyzCache.ok;
  const [pgOk, redisOk] = await Promise.all([db.ping(), cache.ping()]);
  const ok = pgOk && redisOk;
  readyzCache = { ok, at: now };
  return ok;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (req: Request) => Promise<Response> | Response;

function timed(route: string, handler: Handler): Handler {
  return async (req: Request) => {
    const start = performance.now();
    let status = 500;
    try {
      const res = await handler(req);
      status = res.status;
      return res;
    } catch (e) {
      console.error(`[${route}] error:`, e);
      return json({ error: "internal" }, 500);
    } finally {
      const sec = (performance.now() - start) / 1000;
      const labels = { method: req.method, route, status: String(status) };
      httpRequestDuration.observe(labels, sec);
      httpRequestsTotal.inc(labels);
    }
  };
}

const handleLookup = timed("/lookup", async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "invalid body" }, 400);
  const b = body as Record<string, unknown>;
  if (!isIOCType(b.type)) {
    return json({ error: `type must be one of ${IOC_TYPES.join(",")}` }, 400);
  }
  if (typeof b.value !== "string" || b.value.length === 0) {
    return json({ error: "value must be a non-empty string" }, 400);
  }
  const result = await lookup(b.type, b.value);
  return json(result, 200);
});

const handleUpsert = timed("/ioc", async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!authorize(req)) return json({ error: "unauthorized" }, 401);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "invalid body" }, 400);
  const b = body as Record<string, unknown>;
  if (!isIOCType(b.type)) {
    return json({ error: `type must be one of ${IOC_TYPES.join(",")}` }, 400);
  }
  if (typeof b.value !== "string" || b.value.length === 0) {
    return json({ error: "value must be a non-empty string" }, 400);
  }
  if (typeof b.source !== "string" || b.source.length === 0) {
    return json({ error: "source must be a non-empty string" }, 400);
  }
  if (typeof b.score !== "number" || !Number.isFinite(b.score) || b.score < 0 || b.score > 100) {
    return json({ error: "score must be 0-100" }, 400);
  }
  const row = await upsert({
    type: b.type,
    value: b.value,
    source: b.source,
    score: b.score,
  });
  return json(row, 201);
});

const handleMetrics = timed("/metrics", async () => {
  const body = await registry.metrics();
  return new Response(body, {
    status: 200,
    headers: { "content-type": registry.contentType },
  });
});

const handleHealthz: Handler = () => new Response("ok", { status: 200 });

const handleReadyz = timed("/readyz", async () => {
  if (!isReady) return new Response("draining", { status: 503 });
  const ok = await checkReady();
  return ok
    ? new Response("ok", { status: 200 })
    : new Response("dependencies unreachable", { status: 503 });
});

const server = Bun.serve({
  port: PORT,
  idleTimeout: 30,
  routes: {
    "/healthz": handleHealthz,
    "/readyz": handleReadyz,
    "/metrics": handleMetrics,
    "/lookup": handleLookup,
    "/ioc": handleUpsert,
  },
  fetch: () => new Response("not found", { status: 404 }),
});

const inflightTimer = bindInflightSampler(() => server.pendingRequests);

installShutdownHandler({
  setReady: (ready) => {
    isReady = ready;
  },
  stopServer: async () => {
    clearInterval(inflightTimer);
    await server.stop();
  },
});

const waitReady = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) {
    if (await checkReady()) {
      isReady = true;
      console.log(`[server] dependencies reachable; serving at :${PORT}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error("[server] dependencies unreachable after 30s; remaining not-ready");
};
void waitReady();

console.log(`[server] listening at :${PORT}`);
