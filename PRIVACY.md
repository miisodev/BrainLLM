# BrainLLM privacy policy

**Effective 4 October 2026.** This policy covers the BrainLLM software, published by miisodev. The project page at [miiso.dev/brainllm](https://miiso.dev/brainllm) is covered by the [miiso.dev privacy policy](https://miiso.dev/privacy).

## Who holds your data

Whoever runs a BrainLLM server, which is normally you. BrainLLM connects your AI client to a TriliumNext instance you choose. The project has no account system, no hosted service and no access to any server you deploy.

## What the software stores

- **Your notes**, in your own Trilium: what you and your AI client write through BrainLLM, including session logs, diary entries and revisions. They stay there until you delete them in Trilium.
- **Sign-in records**, in a file on your BrainLLM server when OAuth is enabled: registered client applications, single-use authorization codes (ten minutes), and refresh tokens (up to 90 days, rotated on every use and stored only as SHA-256 hashes). Access tokens last one hour and are not stored.
- **Configuration** on your server: the ids of your brain's structural notes, size baselines for maintenance, and the names and dates of named backups.
- **Backups** on your Trilium server, made by Trilium when BrainLLM asks for one.

## What it collects and shares

Nothing. BrainLLM has no analytics, telemetry or usage reporting. A BrainLLM server talks to three parties only: your AI client, your Trilium instance, and, during sign-in, the client's public OAuth metadata document (for Claude, on claude.ai). It reads only what your client asks it to read, and does not access your conversations beyond the content your client sends to its tools.

Your AI client sends tool calls and receives their results. How that client handles your conversations is set by its own provider's policy; for Claude, see [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).

## Logs

A BrainLLM server writes start-up and error messages, and, in HTTP mode, structured request, MCP and shutdown metadata to its own console. The structured log allowlist excludes request bodies, tool arguments and results, JSON-RPC error text, URLs, note ids and tokens; health, readiness and asset requests are not logged. Where those logs go is decided by whoever runs the server and their host.

## Your control

- Read, correct or delete any note in Trilium directly.
- Disconnect a client by removing its connector. To invalidate issued tokens for every client, change `BRAINLLM_OAUTH_SECRET`; removing a connector does not invalidate a token copied elsewhere.
- Delete everything by deleting your Trilium data and your BrainLLM server's volume.

## Changes and contact

Changes to this policy are published in this file and its history in the repository. Questions: [miisodev@gmail.com](mailto:miisodev@gmail.com) or a [GitHub issue](https://github.com/miisodev/BrainLLM/issues).
