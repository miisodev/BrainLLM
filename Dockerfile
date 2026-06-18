# Base image pinned by digest for reproducible builds.
# This is the digest oven/bun:1-alpine resolved to on 2026-06-04 — same bun 1.x
# that matches the committed bun.lock. Re-pin this digest when bumping the lockfile.
FROM oven/bun:1-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN bun build src/index.ts --outfile dist/index.js --target bun

FROM oven/bun:1-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0
WORKDIR /app

# su-exec: drop-privilege helper used by the entrypoint to hand off to bun user.
RUN apk add --no-cache su-exec

COPY --from=builder /app/dist/index.js ./dist/index.js
COPY scripts/entrypoint.sh /entrypoint.sh

# /app is owned by bun so the runtime can write brainllm.json next to the bundle.
# The entrypoint runs as root first (to chown the Railway volume), then execs as bun.
RUN chown -R bun:bun /app && chmod +x /entrypoint.sh

# EXPOSE is documentation-only. The server binds to $PORT (injected by Railway
# or any container host) — not hardcoded to 8080.
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "dist/index.js"]
