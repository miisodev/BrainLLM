#!/bin/sh
# Railway mounts volumes owned by root. Fix ownership so the unprivileged
# bun user (uid 1000) can write brainllm.json there, then hand off.
if [ -d /vol ]; then
  chown bun:bun /vol
fi
exec su-exec bun "$@"
