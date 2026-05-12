import { closeCache } from "./cache";
import { closeDb } from "./db";

export interface ShutdownContext {
  setReady: (ready: boolean) => void;
  stopServer: () => Promise<void>;
}

const GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 5000);

export function installShutdownHandler(ctx: ShutdownContext): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}; failing readyz and draining`);
    ctx.setReady(false);
    await new Promise((r) => setTimeout(r, GRACE_MS));
    await ctx.stopServer();
    await closeDb().catch((e) => console.error("[shutdown] db close error:", e));
    closeCache();
    console.log("[shutdown] complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
