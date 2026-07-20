# Domain Knowledge Lifecycle

Domain knowledge is **gated and current-state**. Read this before creating a domain, adding a sub-category note, or refreshing existing domain content — then pick the one protocol that matches what's actually happening. Never skip the sources gate where one applies, and never manufacture knowledge.

**The markers:** ❇️ = discovered/credible, not yet used. ✅ = used. Markers appear on each source entry as **just the emoji** — marker dates live in the Sources note's **Revision** table, never inline in the list.

**Dates are server policy.** Every Sources and information note carries a `Last updated` line that the server bumps on every content write — you never hand-maintain it. (V8's "one manual date" exception is gone.)

## The canonical Sources note

**Domains are born complete** — creating a domain (any `remember(domain=…)` call that resolves a new name) creates the book AND its canonical Sources note. Its structure, top to bottom (serve it anytime with `template(kind="sources")`):

1. Server header (`sources · domain: <name>`)
2. `Last updated - <date>` (h4) — server-maintained
3. **Sources** (h2) — the ❇️/✅ legend line, then the full, complete source list: **every** source (URL, doc, file, dataset, …) listed and marked individually with just its emoji; related sources grouped under h3 subheadings
4. **Revision** (h2) — a `Source | Marker | Date` table recording each source's current marker and the date it earned it

`remember(kind="sources", domain=…)` **merges into the Sources section** — the note is a maintained clean document, never a stack of dated addendum blocks. Pass `revision=[{source, marker, date?}]` on the same call to upsert Revision-table rows by source name — re-verifying a source replaces its existing row in place, it never grows a new one. Fall back to `revise(find=…)` surgery only for something the upsert can't express (e.g. renaming a source's row key).

## 1. Creating a new domain (the domain doesn't exist yet)

1. Propose the title.
2. Create the domain via any domain-scoped `remember()` — the book and its canonical Sources note are created together (the receipt carries `domainId`).
3. Run an info-query sources-discovery pass and record every candidate in the Sources note, each marked ❇️, grouped with its related sources.
4. Propose/obtain the learning scope from the user (which sources, how deep).
5. Read the approved sources and create the appropriate sub-category `information` note(s).
6. Flip the used entries' markers to ✅ and record the date in the Revision table.
7. `connect()` and wire relations (or pass `connect=` on the `remember()` calls).

If all source candidates are rejected in step 4, **no information note is created** — an unsourced domain note corrupts the brain.

## 2. Adding a sub-category note to an existing domain

Use when the Sources note already covers the relevant source — no new discovery needed. This path extends an already-sourced domain with another sub-category; it is not for introducing new claims.

1. Propose the title.
2. Create the `information` note directly (`remember(kind="information", domain=…, title=…)`).
3. `connect()` and wire relations.

## 3. Maintaining domain knowledge (periodic refresh)

1. Read the Sources note for any ❇️ discovered-but-unused entries → read those sources and create/update the appropriate sub-category `information` note(s).
2. Check the Revision table for ✅ entries last used more than a month ago → verify those sources are still available/credible; update Sources if not.
3. Skim the domain (`domain(name)`) for its sub-category notes → spot-check each against its source for continued correctness — if correct, stop; if not, re-read the source and update the note.
4. Flip markers to ✅ and record dates in the Revision table.
5. `connect()` and wire relations.

## Renames

Retitling a domain book (`revise(bookId, title=…)`) **cascades automatically**: the book's `#domain` slug and every child's are updated server-side, so `domain()` gathering never breaks on a stale slug. Hyphenated slugs (`wall-e`, `framer-templates`) resolve correctly.

## The shape of a domain's surface

A domain's Knowledge surface is exactly: **one maintained Sources note, plus a small set of consolidated, current-state information notes — one per sub-category, never one per day.** It holds what's true now, not a changelog of what was true on each date it was checked.

Chronological, run-by-run history belongs in Memory/Threads — a thread is the right place for "here's what Run N found"; a domain information note is the right place for "here's what's actually true about this sub-category," kept current by revision, not accumulation. If you find yourself naming a new information note after today's date or a run number, stop — that finding either updates an existing note (revise it) or doesn't belong in Domains at all.
