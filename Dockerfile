# Base image pinned by digest for reproducible builds.
# This is the digest oven/bun:1-alpine resolved to on 2026-09-24 — same bun 1.x
# that matches the committed bun.lock. Re-pin this digest when bumping the lockfile.
FROM oven/bun:1-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN bun build src/index.ts --outfile dist/index.js --target bun

FROM oven/bun:1-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f
WORKDIR /app

# su-exec: drop-privilege helper used by the entrypoint to hand off to bun user.
RUN apk add --no-cache su-exec

COPY --from=builder /app/dist/index.js ./dist/index.js
# Icon assets are served same-origin from /icon.png and /icon.svg. The MCP
# spec tells clients to verify icon URIs share the server origin, so a
# third-party URL (raw.githubusercontent.com) is silently rejected.
COPY public/ ./public/
COPY scripts/entrypoint.sh /entrypoint.sh

# /app is owned by bun so the runtime can write brainllm.json next to the bundle.
# The entrypoint runs as root first (to chown the Railway volume), then execs as bun.
RUN chown -R bun:bun /app && chmod +x /entrypoint.sh

# EXPOSE is documentation-only. The server binds to $PORT (injected by Railway
# or any container host) — not hardcoded to 8080.
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "dist/index.js"]
