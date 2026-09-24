# Security Policy

## Supported versions

Security fixes ship on the latest release line. Older versions may remain useful for compatibility, but upgrade before relying on them for an internet-facing deployment.

| Version | Supported |
|---|---|
| 12.4.x | ✅ |
| 12.3.x and earlier | ❌ |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, and do not include credentials, ETAPI tokens, OAuth tokens, or private brain content in a report.

Use GitHub's private **Report a vulnerability** form for this repository, or email **miisodev@gmail.com** with:

- affected BrainLLM version and deployment mode (stdio, HTTP, Docker, or Railway);
- the request or sequence that reproduces the issue;
- the expected and observed behaviour;
- impact and any evidence already collected.

Please use a private channel until a fix and coordinated disclosure path are agreed. Do not test against data or accounts you do not own.

## Deployment guidance

Run the latest tagged release rather than an unreleased branch or a mutable dependency lock. For an HTTP deployment reachable outside a trusted network, set `MCP_AUTH_TOKEN`; configure `BRAINLLM_OWNER_PASSWORD` only when hosted OAuth clients require it. Keep the Trilium instance, ETAPI token, OAuth store, and `brainllm.json` on protected storage, and restrict network access at the platform edge.

For credential rotation, replace `MCP_AUTH_TOKEN` and the ETAPI token in the provider/Trilium, set a fresh `BRAINLLM_OAUTH_SECRET` (32+ characters) to invalidate existing OAuth tokens, and remove obsolete local `*.oauth.json` / `*.token` files. Never put recovered credentials in a repository, shared context note, Docker context, or release artifact.

## Scope

BrainLLM is an MCP server over TriliumNext's ETAPI boundary. Vulnerabilities in Trilium itself should be reported to the TriliumNext project unless the issue is caused by BrainLLM's use of that boundary.
