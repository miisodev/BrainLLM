# Domain Knowledge Lifecycle

Read this before creating a domain, adding a sub-category note, or refreshing domain content, then follow the one protocol that matches. Never skip the sources gate and never manufacture knowledge.

## The shape of a domain

A domain is **one Sources note plus one information note per sub-category**, each a maintained document revised in place.

| Note | Holds |
|---|---|
| **Sources** | every source, marked ❇️ discovered / ✅ used, grouped under h3s; a **Revision** table (Source · Marker · Date) |
| **Current State** | the domain's **measured state** — what is live, built, deployed, counted — latest value only, with the date it was measured. The only information note that holds state |
| any other information note | **timeless knowledge**: how the thing works, its rules, its architecture, its constraints. No state, versions, dates, incidents or decision history |
| a `#mandate` note (optional) | a standing brief a session must follow (e.g. a founder brief) — `remember(..., mandate=true)` |

**History and decisions never live in a domain.** "What run N found" and "what Miiso decided on a date" go to the venture's thread entries; the domain holds the resulting truth. If you are about to write a date into a non-Current-State note, it belongs in Current State (a measurement) or in a thread entry (an event).

Markers are just the emoji on each source; their dates live only in the Revision table. `Last updated` lines are server-maintained. Titles are ≤ 4 words with no dates or run numbers; a sub-category that needs more words is two sub-categories. Read a sibling before writing and match it; improve a pattern across every domain or not at all.

## The Sources note

Creating a domain creates the book and its Sources note together. `remember(kind="sources", domain=…)` merges into the Sources section; pass `revision=[{source, marker, date?}]` to upsert Revision rows by source name (the name must match the list exactly).

## 1. Creating a domain

1. Propose the title.
2. Any domain-scoped `remember()` creates the book and its Sources note.
3. Discover sources and record each as ❇️, grouped.
4. Agree the learning scope with the user.
5. Read the approved sources; write the information notes, starting with **Current State**.
6. Flip used sources to ✅ with their Revision dates.
7. Wire relations (`connect=` on the `remember` calls).

If every source is rejected, create no information note — an unsourced note corrupts the brain.

## 2. Adding a sub-category

For a source the Sources note already covers: `remember(kind="information", domain, title, body, mustCreate=true)`, then wire it.

## 3. Refreshing a domain

1. Read ❇️ sources not yet used; fold what they teach into the right notes.
2. Re-check ✅ sources older than a month; update Sources if they moved.
3. Re-measure **Current State** against live sources; replace values in place, then run `consistency()` on anything recorded twice.
4. Spot-check each other note for correctness and for state or history that has crept in (`maintain(deep)` flags dated prose).
5. Update markers and Revision dates; wire relations.

## Renames

Retitling a domain book cascades its `#domain` slug to every child automatically.
