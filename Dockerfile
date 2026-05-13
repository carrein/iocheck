# syntax=docker/dockerfile:1.7
# Multi-stage build for iocheck service on Bun.

FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=2s --start-period=15s --retries=3 \
  CMD bun --eval "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["bun", "run", "src/server.ts"]
