// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — brand identity, in one place
//
// The server presents itself in several places a person or a client reads: the
// MCP handshake (serverInfo, instructions), the pages it serves (landing,
// consent, errors), and the package metadata (package.json, manifest.json,
// server.json). They used to carry their own wording and their own drawing of
// the mark, and drifted: one called it a "second brain", which the brand rules
// out, and the pages drew the mark from CSS dots rather than its geometry.
// Everything brand-shaped is defined here, and brand.test.ts checks the
// package metadata against it.
// ─────────────────────────────────────────────────────────────────────────────

export const BRAND = {
  name: "BrainLLM",
  /** The line the product owns. */
  tagline: "Give Claude a memory that survives the session",
  /** One sentence, at most 100 characters: the MCP registry's limit for
   *  server.json, and the same sentence everywhere else. */
  description: "Self-hosted memory for LLMs in TriliumNext, structured by the server and editable by you.",
  website: "https://miisodev.github.io/BrainLLM/",
  repository: "https://github.com/miisodev/BrainLLM",
  publisher: "miisodev",
  colors: { ground: "#0a0a0f", accent: "#f59e0b", nodeOff: "#3f3f46" },
} as const;

/** The mark's exact geometry, shared with public/BrainLLM.svg: a 3x3 grid on a
 *  92-unit pitch, six nodes lit and three dark. Row-major; true = lit. */
export const MARK_GRID: readonly boolean[] = [
  true, false, true,
  true, true, false,
  false, true, true,
];

/** The mark as inline SVG, for pages whose CSP forbids external images. Same
 *  grid as the source artwork, without the plate, sized by the caller. */
export function markSvg(size = 22): string {
  const dots = MARK_GRID.map((lit, i) => {
    const cx = 164 + (i % 3) * 92;
    const cy = 164 + Math.floor(i / 3) * 92;
    return `<circle cx="${cx}" cy="${cy}" r="38" fill="${lit ? BRAND.colors.accent : BRAND.colors.nodeOff}"/>`;
  }).join("");
  return `<svg class="brand-mark" width="${size}" height="${size}" viewBox="110 110 292 292" aria-hidden="true">${dots}</svg>`;
}

/** What the server tells a client it is, in the initialize response. Plain
 *  description of the surfaces and the session shape; no directives. */
export const SERVER_INSTRUCTIONS = [
  `${BRAND.name} is the user's persistent memory, stored in their own TriliumNext instance. Every note is one the user can open, read and correct.`,
  "The brain has five areas: Master (about the user), LLM (the assistant's operating notes and daily diary), Memory (threads and session logs), Knowledge (domains of sourced notes) and Insights (daily change logs and the relation graph).",
  "A session typically opens with start(), which returns the user's stored preferences and protocols and what changed since the last session, and ends with session() and close(), which write the session log. remember() and revise() write; recall(), domain() and the surface reads (master, llm, memory, knowledge, insights) read.",
  "The server owns placement, labels, deduplication, dates and backups, so writes need content, not bookkeeping.",
].join("\n\n");

/** Icons for serverInfo. PNG first: every client must render PNG, SVG is
 *  optional. Same-origin URLs in HTTP mode, because clients drop icons from
 *  another origin; the repository's raw files only under stdio, where there is
 *  no origin to compare against. */
export function brandIcons(origin: string | null) {
  const REPO_RAW = "https://raw.githubusercontent.com/miisodev/BrainLLM/main/public";
  const at = (file: string) => (origin ? `${origin}/${file}` : `${REPO_RAW}/${file}`);
  return [
    { src: at("icon-128.png"), mimeType: "image/png", sizes: ["128x128"] },
    { src: at("icon-512.png"), mimeType: "image/png", sizes: ["512x512"] },
    { src: origin ? `${origin}/icon.svg` : `${REPO_RAW}/BrainLLM.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
  ];
}
