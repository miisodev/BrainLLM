# BrainLLM — Dev Workflow

## Standard change workflow

For every code change, in order:

1. **Fix** the code.
2. **Build** — `bun run build` (must pass clean before committing).
3. **Update docs** — if the change affects observable behaviour, update `skills/brainllm/SKILL.md` and `README.md`. No update needed for pure bug fixes with no user-visible contract change.
4. **Commit** with a conventional commit message (`fix:`, `feat:`, `docs:`, `refactor:`).
5. **Push** to `origin/main`.

```powershell
bun run build
git add <files>
git commit -m "type: short description"
git push
```

The user will say "commit and push" or "fix, update skill and readme if needed and commit+push" — these both mean: run the full workflow above.

## Conventions

- Commits are signed with `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`.
- One logical change per commit; don't batch unrelated fixes.
- SKILL.md is the operational guide for the LLM using BrainLLM — keep it precise and action-oriented.
- README.md is the user-facing feature summary — update the relevant bullet/section only.
