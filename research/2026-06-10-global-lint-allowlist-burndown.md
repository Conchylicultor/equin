# Lint allowlist burn-down migration

## Context

Three lint rules each landed as repo-wide `error` without a blocking sweep by
freezing their current offenders in a hand-maintained `ignores` file-path
allowlist inside their own lint barrel. New code is blocked immediately; legacy
was meant to "burn down one entry at a time" — but nothing drives that
burn-down, so the lists have sat frozen and started to rot (7 entries already
point at files that no longer exist).

This plan covers **only the file migration**: converting each allowlisted file
to the sanctioned token-driven primitive and deleting its allowlist entry. The
*mechanism* that should track/govern allowlists generically (ratchet, staleness
detection, single registration point) is a **separate filed task**
(`task-1781114628013-ep3ry5`) and is explicitly out of scope here. This
migration edits the existing per-barrel `ignores` arrays directly; if the
centralized system lands first, the per-file recipe is unchanged (migrate file →
remove its entry → verify).

## Scope — the three allowlists

| Rule | Barrel (`ignores` lives here) | Live entries | Target primitive |
|---|---|---|---|
| `radius/no-adhoc-radius` | `plugins/primitives/plugins/radius/lint/index.ts` | 92 (1 stale) | token `rounded-{sm,md,lg,xl,…}` scale |
| `text/no-adhoc-typography` | `plugins/primitives/plugins/text/lint/index.ts` | 306 | `<Text variant>` (or `text-2xs`/`text-3xs` sub-scale) |
| `typography-tokens/no-arbitrary-font-size` | `plugins/ui/plugins/tokens/plugins/typography/lint/index.ts` | 88 (6 stale) | named font token; `<Text variant>` if it would land on `text-xs`+ |

**354 unique live files** (361 listed − 7 stale). Membership: **241 on exactly
one list, 94 on two, 19 on all three.** The 5 empty-by-design rules (`row`,
`badge`, `control-size`, `z-layers`, `web-core`) have no allowlist and are not
part of this work.

## Key mechanics (from code, not assumption)

### radius/no-adhoc-radius
- Fires on bare `rounded` (`/^rounded$/`) and arbitrary `rounded-[…]`
  (`/^rounded-\[/`) inside `className`/`cn`/`clsx`/`twMerge`. Allowed:
  `rounded-none`, `rounded-full`, and the scale `rounded-{sm,md,lg,xl,2xl,3xl}`.
- Default replacement for bare `rounded` is **`rounded-md`** (per CLAUDE.md and
  the two enforced reference files `row.tsx`, `resize-handle.tsx`). Scale (Default
  preset, `--radius=0.625rem`): `sm≈6px, md=8px, lg=10px, xl=14px`. Match
  `rounded-[Npx]` to the nearest step (`[2px]`/`[6px]`→`sm`, `[8px]`→`md`,
  `[10px]`→`lg`).
- A genuinely-fixed literal that must survive Shape presets (e.g. `button.tsx`'s
  `rounded-[min(var(--radius-md),10px)]` clamp) keeps an inline
  `// eslint-disable-next-line radius/no-adhoc-radius -- <reason>` instead of an
  allowlist entry.

### text/no-adhoc-typography
- Fires on named sizes `text-{xs,sm,base,lg,xl,2-9xl}` and any `leading-*`.
  **Does NOT fire** on color classes (`text-muted-foreground` etc.), the
  sub-scale `text-2xs`/`text-3xs`, or layout classes.
- Replace with `<Text variant>` (`as=` preserves the element, `className=`
  carries layout/color). Mapping: `text-xl/2xl+font-semibold`→`title`,
  `text-lg`→`heading`, `text-base font-semibold`→`subheading`,
  `text-sm`/`leading-6`→`body`, `text-sm font-medium`→`label`, `text-xs`→`caption`.
- No inline-disable usage exists today; `markdown/.../base-components.tsx` stays
  allowlisted permanently (inline-code `text-xs` is legitimate sub-scale).

### typography-tokens/no-arbitrary-font-size
- Fires on `text-[Npx]`/`text-[Nrem]`. Auto-fix exists for three:
  `[10px]`→`text-3xs`, `[11px]`→`text-2xs`, `[12px]`→`text-xs`. Off-scale values
  have no auto-fix (need a token added in `group.ts` or `<Text>`).

### ⚠ The bounce constraint (drives sequencing)
`text-3xs`/`text-2xs` are **permanently sanctioned** sub-scale — auto-fixing
`[10px]`/`[11px]` is a clean final state. But `[12px]`→`text-xs` **immediately
trips `no-adhoc-typography`**, whose correct end-state is `<Text variant="caption">`.
**Therefore a file on both typography lists must be cleared from both in the
same change** — never satisfy one rule by introducing a class the other bans.
The recipe below enforces this by migrating per-file across *all* lists the file
appears on at once.

## Migration recipe (per file — the unit of work)

1. Identify every list the file is on (radius / text / typo).
2. Fix all offending classes to their token/primitive end-state (sections
   above). For typography, drive to `<Text variant>` or the sub-scale tokens —
   never to a `text-xs`+ named size.
3. Delete the file's entry from **every** `ignores` array it appears in.
4. Verify (below). If a residual literal is genuinely intentional, use the
   inline `eslint-disable-next-line` escape hatch with a reason instead of
   re-adding the allowlist entry.

## Verification

- **Per file:** `bunx eslint <file>` after removing its entries — must be clean
  (this is exactly what the future ratchet check will automate).
- **Per batch:** `./equin check eslint` stays green.
- **End-to-end:** `./equin build`, then load the affected app at
  `http://<worktree>.localhost:9000` and confirm no visual regression (radius
  swaps and `<Text>` swaps are size-equivalent by design, so diffs should be
  imperceptible). Spot-check a Shape preset switch (Sharp/Pill) on a migrated
  surface to confirm corners now re-scale.
- **Done signal:** all three `ignores` arrays contain only the intentional
  permanent entries (`markdown/base-components.tsx` for text; any documented
  fixed-literal that opted for an inline disable instead). Ideally the arrays go
  empty + the rule's `ignores` key is dropped.

## Sequencing

**Phase 0 — prune the 7 stale entries (free, do first).** Remove allowlist
entries whose files no longer exist: 1 in radius
(`reorder/web/internal/dnd-components.tsx`) and 6 in typo (the
`studio/contributions/categories/*` set, `studio/.../catalog-view.tsx`,
`studio/.../tables-table.tsx`, `plugin-view/.../public-api-section.tsx`). No
code change, just delete the lines; `eslint` check confirms.

**Phase 1 — single-list, auto-fixable (lowest risk).** The 241 single-list
files, starting with `no-arbitrary-font-size`-only files whose sole offense is
`[10px]`/`[11px]` (mechanical `text-3xs`/`text-2xs`, no bounce, no `<Text>`).
These can run with `eslint --fix` then entry removal.

**Phase 2 — multi-list files, batched by umbrella (highest leverage).** The 94
two-list + 19 three-list files: one edit pass clears 2–3 entries each, and the
bounce constraint *requires* doing them together. Batch by top-level umbrella so
one agent owns a coherent subtree and shared components migrate consistently:

| Umbrella | Files | | Umbrella | Files |
|---|---|---|---|---|
| `conversations` | 97 | | `stats` | 13 |
| `primitives` | 39 | | `page` | 13 |
| `ui` | 25 | | `debug` | 13 |
| `tasks` | 21 | | `fields` | 12 |
| `apps/sonata` | 20 | | `apps/studio` | 11 |
| `plugin-meta` | 16 | | `review` / `framework` | 10 each |

`conversations` (97) should itself be split by sub-app
(`conversation-view/jsonl-viewer/tool-call/*` is the bulk). `primitives` first
within Phase 2 — shared components there propagate correct usage to consumers.

**Phase 3 — close out.** Migrate the long tail (umbrellas with ≤6 files), then
delete the now-empty `ignores` arrays (and the `ignores:` key) on each barrel,
leaving only the documented permanent exceptions.

Execution suggestion: one agent per umbrella batch (Phase 2/3), each running the
per-file recipe + per-file `eslint` verification, then a single
`./equin build` + visual spot-check per batch. Sonnet is sufficient for
the auto-fixable Phase 1; Phase 2 `<Text>` conversions involve judgment
(variant choice, `as=`/`className=` splitting) and suit Opus.

## Critical files

- `plugins/primitives/plugins/radius/lint/index.ts` — radius `ignores`
- `plugins/primitives/plugins/text/lint/index.ts` — typography `ignores`
- `plugins/ui/plugins/tokens/plugins/typography/lint/index.ts` — arbitrary-size `ignores`
- `plugins/primitives/plugins/text/web/internal/text.tsx` — `<Text>` variant API
- `plugins/framework/plugins/web-core/web/theme/app.css` — `--radius-*` scale + `text-*` variant utilities
- Reference migrations (enforced, copy their shape): `plugins/primitives/plugins/row/web/internal/row.tsx`, `plugins/layouts/plugins/miller/web/components/resize-handle.tsx`, `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/assistant-text/web/components/assistant-text-row.tsx`

## Relationship to the centralized-allowlist task

`task-1781114628013-ep3ry5` will build the generic ratchet/registration system.
The two are independent and order-insensitive: this migration shrinks the
arrays; that task changes how the arrays are governed. If that task lands first,
the per-file recipe is identical (the staleness/removability checks it adds will
in fact *enforce* each step of this burn-down automatically).
