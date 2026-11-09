# Connect BrainLLM to Claude

## What you need

BrainLLM is self-hosted: each person runs their own server against their own Trilium. Connected MCP clients receive tool results under their own data policies. Before connecting you need:

- A running [TriliumNext](https://github.com/TriliumNext/Trilium) instance and an ETAPI token (Options → ETAPI → Create token).
- For claude.ai and the Claude apps: BrainLLM running somewhere reachable over HTTPS, with `BRAINLLM_OWNER_PASSWORD` set.
- For Claude Code or Claude Desktop on one computer: nothing else; they can start BrainLLM locally.

## Deploy your server

The repository includes a Dockerfile. On any container host, set these variables and mount a volume:

```sh
TRILIUM_BASE_URL=https://your-trilium.example.com
TRILIUM_ETAPI_TOKEN=your-token
BRAINLLM_OWNER_PASSWORD=a-long-password      # 16+ characters when TOTP is set
BRAINLLM_OWNER_TOTP_SECRET=YOUR_BASE32_SEED  # optional; enroll it first
BRAINLLM_CONFIG=/vol/brainllm.json            # a file on the volume
PORT=8080
```

Your server's MCP address is then `https://your-host/mcp`. Opening `https://your-host/` in a browser shows a page confirming it is running. Full reference: [configuration](../README.md#configuration-reference).

## claude.ai, Claude mobile and Cowork

1. In Claude, open Settings → Connectors → Add custom connector.
2. Name it BrainLLM and enter your server's address, `https://your-host/mcp`.
3. Claude opens BrainLLM's consent screen. Check it names **claude.ai** and returns to claude.ai, enter your owner password and choose Authorize. If the owner second factor is enabled, enter the current six-digit code from your authenticator app too.
4. The connector appears in Claude on the web, desktop and mobile apps, and in Cowork.

With `BRAINLLM_OWNER_TOTP_SECRET` set, enroll the base32 seed in your authenticator and keep an offline backup before enabling it. A lost authenticator is recovered from that backup, or by a deployment admin removing the variable and redeploying; existing tokens keep working.

> To stop access, remove the connector in Claude, or change `BRAINLLM_OAUTH_SECRET` on your server to invalidate every token at once.

## Claude Code

```sh
# a remote server
claude mcp add --transport http brainllm https://your-host/mcp
# or a local one, started by Claude Code
claude mcp add brainllm -e TRILIUM_BASE_URL=http://localhost:8080 -e TRILIUM_ETAPI_TOKEN=your-token -- npx -y brainllm
```

For a remote server, Claude Code opens the consent screen in your browser. It returns to an address on your own computer, and the screen says so.

## Claude Desktop

Add BrainLLM to the desktop app's MCP configuration as shown in [Configure your MCP client](../README.md#3-configure-your-mcp-client), or connect the remote server as a custom connector, the same way as on claude.ai.

## The first session

On a new Trilium, ask Claude to bootstrap BrainLLM; it calls `bootstrap()` once to build the five-area tree. From then on a session typically opens with `start()` and closes with `close()`. For the full working discipline, give Claude the BrainLLM skill (`skills/brainllm.zip` in the repository, also attached to each release).

## Example prompts

- "Set up BrainLLM in my Trilium and remember that I prefer short answers with the decision first."
- "Start a thread called Website relaunch with the goal of shipping the new site by the end of the month, and log today's decisions in it."
- "What did we decide about pricing last week, and why?"
- "Check whether my notes still agree on the launch date, and fix any that don't."
- "Close the session: write the log and your diary for today."

## What it can access

BrainLLM reads and writes notes in the Trilium instance it is configured for, and nothing else. Its tools are built around the BrainLLM tree, though a tool given another note's id in that Trilium can read or edit it; `BRAINLLM_MODE=full` adds raw tools for direct Trilium operations. Every content write takes a revision first, so a change can be inspected with `diff` and undone. It makes no other network requests except fetching a client's public OAuth metadata during sign-in. See the [privacy policy](../PRIVACY.md).

## Support

- **Questions and bugs:** [GitHub issues](https://github.com/miisodev/BrainLLM/issues).
- **Email:** [miisodev@gmail.com](mailto:miisodev@gmail.com).
- **Security reports:** privately, as described in the [security policy](https://github.com/miisodev/BrainLLM/security/policy).
