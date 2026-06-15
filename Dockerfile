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

COPY --from=builder /app/dist/index.js ./dist/index.js

# Drop root: run as the unprivileged `bun` user (uid 1000) baked into the image.
# chown so the runtime can still write brainllm.json next to the bundle.
RUN chown -R bun:bun /app
USER bun

EXPOSE 8080
CMD ["bun", "dist/index.js"]
