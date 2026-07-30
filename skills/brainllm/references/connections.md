# Connection Auditing Protocol

A deliberate graph-deepening pass — not a casual ask. Run it when:

- the user asks to **update, audit, or deepen connections**;
- `maintain(deep=true)` keeps flagging the same orphans/sinks session after session;
- periodically, as part of deep maintenance (~monthly, or after a burst of new content).

Budget a full pass. Exhaustiveness is the point: check every note against every plausible counterpart, not just the first few obvious pairs.

## The sequence

1. **Inventory** — `brain()` to list every content note across all five areas. It already returns a `relations` snippet on every entry, so the inventory pass alone gives you most of the graph; reach for `inspect()` in step 2 only for the labels or the full edge list it doesn't cover. (On a ~200-note brain that is roughly 80 calls you don't make.)
2. **Read the actual edges** — where the snippet isn't enough (it caps at 8 outbound edges and omits labels), `inspect(noteId)` for the complete picture. Don't rely on `domain()`'s grouping alone — it surfaces `#domain`/`#topic` *membership*, not graph edges; two notes can share a slug and still be unwired.
3. **Cross-reference bodies** — look for genuine but unwired overlaps: shared topics or tools, sequencing/dependency implied by the user's Goals, schedule cross-references, and hub notes (a project or venture hub, a domain container) that should reference every member.
4. **Wire everything real** — `connect()` every real relation found, no matter how minor — a shared tool, a sequencing dependency, a schedule cross-reference all count. Skip only where no real relation exists; **never invent one to pad the pass**.
5. **Spot-check** — every audit ends by running `explore(noteId, mode="neighborhood")` from 2–3 wired hub notes to confirm they surface their members.

## Principles

- **Specificity over `relatesTo`.** `relatesTo` is the last resort, not the default — reach for `sourceOf` / `derivedFrom` / `extends` / `partOf` / `references` / `supports` when they fit better. Full vocabulary with per-relation guidance: `taxonomy.md`.
- **Exhaustive, not performative.** The pass is complete when every note has been checked against every plausible counterpart — a real relation skipped is a recall failure later; a fake relation added is noise forever.
- **Prevention beats auditing.** `remember(connect=[{relation, toNoteId}, …])` wires relations at creation, and a freshly-created connectable note without any returns an orphan-prevention hint — act on it in the moment and the periodic audit stays small.
- **A flag you've decided is fine gets acknowledged, not ignored.** When a note legitimately has no outbound edge, `maintain(ack=[noteId])` — it goes quiet until its content changes, then comes back. Repeatedly ignoring the same flag is how you end up skimming the whole list, which is where the one finding that *did* change gets missed.
- **Sibling inconsistency is the gap `maintain` cannot see.** Orphan/sink detection only finds notes with *no* edges. The real misses are notes that have plenty of edges but not the one all their siblings have — a hub that tracks six members and links five, a domain note missing the thread link its six peers carry. Those only surface by reading a hub note's content against what it claims to track, which is step 3, and it is the step most often under-done.

## Traversal reliability

`explore(mode="neighborhood")` walks **both directions** by default — inbound edges appear as `←relation` in `via` — so a hub or domain note wired only via inbound edges from its members is not invisible to traversal. The old workaround of adding reciprocal outbound edges just to make traversal reach a hub is unnecessary.

Still wire hub notes outward when it's semantically true — the hub really does relate to each member, not just the reverse. That's about the graph being *correct*, not about making traversal work.
