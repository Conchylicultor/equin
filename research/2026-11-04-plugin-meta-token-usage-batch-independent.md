# Token usage independent of the scan batch

## Context

`plugin-meta/token-usage`'s `tokenVarsUsedBy(root, groups)` runs oxide ONCE over
every group, compiles the candidates, then builds ONE regex from every
var-reading candidate of the whole batch and matches it against each group's
text. A group's verdict therefore depends on the other groups: a class text
that oxide does not extract from group A (`pr-floating-bar*` in a comment — the
`*` stops oxide) or that A only names in prose (`(control-sm, px-control-sm,
text-caption)`, view-core `editable-view-switcher.tsx:155`) is attributed to A
only when some other group in the batch really uses that class. The build's
incremental docgen (a small batch of missed records) and the check's full scan
disagree, so `./equin build` fails its own `plugins-doc-in-sync` (view-core:
30 vs 34 vars; desktop/windows: 23 vs 24, `--chrome-pad-x`).

Violates checks/CLAUDE.md: "A scope: tree verdict must not depend on the process
that produced it".

## Decision

1. **Attribution is per group, by construction.** Each group is scanned by its
   own `new Scanner({}).scanFiles(groupFiles)`; its candidates ARE its classes
   (set lookup into `byCandidate`), no cross-group regex. The union of the
   per-group candidates equals the batch scan (measured: 92,639 both), so the
   compile step is unchanged, just fed from the per-group sets. A group's result
   is now a pure function of its own files and app.css.
2. **A class or `var(--x)` written only in a comment is not a use.** A comment
   styles nothing; counting it makes an edge (a hard bundle dependency) out of
   prose. Before scanning, `.ts`/`.tsx` text goes through
   `maskSource(content)` (`plugin-meta/parse-utils` core; comments and regex
   literals blanked, strings kept, same length); `.css` text has its `/* … */`
   blocks blanked (CSS has no `//` comment, so maskSource's JS grammar is wrong
   for it — `url(https://…)`). The literal `var()` pass reads the masked text
   too. Known masker limit: JSX-text apostrophes desync it in ~10 files
   (task-1793821227-0rsx5d) — still deterministic per file, so the invariant
   holds; the result is only as exact as the masker.

## Cost

Measured over the repo's styled sources (7,890 files, 1,375 plugin groups):
one batch scan 0.57 s, per-group scans 2.5 s. Paid only on a cold full extract
(records are per plugin and persisted, so a build re-extracts just the missed
plugins; the check reads the same records). The per-group calls also yield
between groups through the existing time slicer, instead of one 0.57 s block.
No memo added.

## Changes

- `plugins/plugin-meta/plugins/token-usage/core/token-usage.ts` — per-group
  scan + mask, drop `classRe` / `escapeRegExp`; docstring rewritten.
- `plugins/plugin-meta/plugins/token-usage/CLAUDE.md` — the "Usage" paragraph
  (no more "ONE batch"; comments don't count; why per group).
- `core/token-usage.test.ts` — new tests:
  - a group rendered alone and inside a batch with a group that really uses the
    class gives the same set (the `pr-floating-bar*` comment shape and the
    prose-list shape);
  - a class / `var()` only in a comment (TS line + block, CSS block) reads nothing,
    the same class in a `className` string does.
- Regenerated docs from `./equin build` (view-core etc. drop comment-only tokens).

Workarounds: the `pr-floating-bar*` comment is unchanged on main (that reword
never landed) and view-core's committed docs are simply regenerated — nothing
else to undo.

## Verification

- `./equin test plugins/plugin-meta/plugins/token-usage`,
  `./equin test plugins/framework/plugins/tooling/plugins/codegen`.
- `./equin build` green (incl. `plugins-doc-in-sync`); then touch a view-core
  web file (no-op whitespace edit, reverted) and `./equin check
  plugins-doc-in-sync` to confirm incremental == full.
- Independent sonnet review of `git diff $(git merge-base HEAD main)`.
