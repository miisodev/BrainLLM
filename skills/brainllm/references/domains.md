# Domain Knowledge Lifecycle

Domain knowledge is **gated and current-state**. Read this before creating a domain, adding a sub-category note, or refreshing existing domain content — then pick the one protocol that matches what's actually happening. Never skip the sources gate where one applies, and never manufacture knowledge.

**The markers:** ❇️ = discovered/credible, not yet used. ✅ = used, dated. **A Sources entry only earns a date when it has actually been read and used — never on discovery alone.**

Every domain `information` note carries a visible, maintained first line in its body — `Last updated: yyyy-mm-dd` — kept current by whoever last revises the note's content. (This is the one manual date you write; all other date-stamping is server policy.)

## 1. Creating a new domain (the domain doesn't exist yet)

1. Propose the title.
2. Create the domain (book) + its Sources note, both carrying a top-level status marker.
3. Run an info-query sources-discovery pass and record every candidate in the Sources note, each marked ❇️ (discovered/credible, not yet used).
4. Propose/obtain the learning scope from the user (which sources, how deep).
5. Read the approved sources and create the appropriate sub-category `information` note(s), each opening with a `Last updated: yyyy-mm-dd` line.
6. Flip the used entries in Sources to ✅ with the date used.
7. `connect()` and wire relations (or pass `connect=` on the `remember()` calls).

If all source candidates are rejected in step 4, **no domain note is created** — an unsourced domain note corrupts the brain.

## 2. Adding a sub-category note to an existing domain

Use when the Sources note already exists and already covers the relevant source — no new discovery needed. This path extends an already-sourced domain with another sub-category; it is not for introducing new claims.

1. Propose the title.
2. Create the `information` note directly, opening with a `Last updated: yyyy-mm-dd` line.
3. `connect()` and wire relations.

## 3. Maintaining domain knowledge (periodic refresh)

1. Read the Sources note for any ❇️ discovered-but-unused entries → read those sources and create/update the appropriate sub-category `information` note(s) (refresh the `Last updated:` line).
2. Check Sources for ✅ entries last used more than a month ago → verify those sources are still available/credible; update Sources if not.
3. Skim the domain (`domain(name)`) for its sub-category notes → spot-check each against its source for continued correctness — if correct, stop; if not, re-read the source and update the note (refresh its `Last updated:` line).
4. Flip Sources entries to ✅ with the date used.
5. `connect()` and wire relations.

## The shape of a domain's surface

A domain's Knowledge surface is exactly: **one maintained Sources note, plus a small set of consolidated, current-state information notes — one per sub-category, never one per day.** It holds what's true now, not a changelog of what was true on each date it was checked.

Chronological, run-by-run history belongs in Memory/Threads — a thread is the right place for "here's what Run N found"; a domain information note is the right place for "here's what's actually true about this sub-category," kept current by revision, not accumulation. If you find yourself naming a new information note after today's date or a run number, stop — that finding either updates an existing note (revise it) or doesn't belong in Domains at all.
