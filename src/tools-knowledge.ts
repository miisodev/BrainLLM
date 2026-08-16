// BrainLLM — Knowledge surface (read). User-knowledge notes + domain books
// (each holding a Sources note and sub-category information notes).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient, type Note } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { slugify } from "./normalize.js";
import { txt, skim, readFull } from "./tools-surface.js";

export function registerKnowledgeTools(server: McpServer, trilium: TriliumClient, brainRef: { config: BrainLLMConfig }): void {
  const b = () => brainRef.config;

  server.tool(
    "knowledge",
    `Read a Knowledge note by id — a user-knowledge note, a domain information note, or a Sources note.

Pass section="<heading>" to read ONE section instead of the whole body — the read-side
counterpart to revise(section=), matching on the same heading contract, so a name that reads
also writes. Use it on anything large: a note past the read ceiling cannot be returned whole at
all, and outline(id) lists the headings to choose from. occurrence= disambiguates repeated
heading texts.`,
    {
      id: z.string(),
      section: z.string().optional().describe("Read only this heading's section (h2/h3/h4), instead of the whole note"),
      occurrence: z.number().int().positive().optional().describe("section=: which same-text heading, 1-based (default: the first)"),
    },
    async ({ id, section, occurrence }) => txt(await readFull(trilium, id, { section, occurrence }))
  );

  server.tool(
    "knowledge_recall",
    "Skim Knowledge. With a domain: that domain's Sources + information notes. Without: user-knowledge notes plus the list of domains.",
    { query: z.string().optional(), domain: z.string().optional() },
    async ({ query, domain }) => {
      const cfg = b();
      if (domain) {
        const slug = slugify(domain);
        const found = await trilium
          .searchNotes(`#noteType=domain #domain='${slug}'`, { ancestorNoteId: cfg.knowledge.domains, fastSearch: true, limit: 1 })
          .catch(() => ({ results: [] as Note[] }));
        const dom = found.results[0];
        if (!dom) return txt({ note: `No domain "${domain}" yet.` });
        return txt({ domain: dom.title, contents: await skim(trilium, dom.noteId, { query, limit: 50 }) });
      }
      const domains = await skim(trilium, cfg.knowledge.domains, { kind: "domain", limit: 50 });
      return txt({
        userKnowledge: await skim(trilium, cfg.knowledge.master, { kind: "user", query, limit: 30 }),
        domains: domains.map((d) => ({ id: d.id, title: d.title })),
      });
    }
  );
}
