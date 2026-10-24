# DataView adoption guardrail: `no-adhoc-row-list` lint + decision-rule docs + full migration burndown

## Context

The Studio Compositions pane (`/studio/compositions`) hand-rolls its composition
list with `.map()` → `<Row>` — including a hand-rolled groupBy — even though the
DataView primitive existed ten days before the pane was built, and the Explorer
in the *same app* was migrated to DataView three days after. Root cause analysis:

- **Every existing guardrail fires *after* an agent adopts DataView**
  (`data-view:configs-authored` fails until the config is authored), and
  **nothing fires when an agent avoids it**. The wrong path (`.map` → `<Row>`)
  is lint-clean and 10× cheaper.
- **No decision rule exists anywhere** saying when a list must be a DataView.
  `Row`'s own description sanctions it for "list" rows.

An audit of all `.map()` → `<Row>` sites (16 files + a broader sweep) found
6 genuine standing data surfaces hand-rolled, ~10 legitimate transient-chrome
uses, and a cluster of per-entity "activity sections" with zero
sort/filter/search that DataView provides for free.

This change makes DataView the reflex, the same way `no-adhoc-spacing` /
`no-adhoc-layout` / `no-hand-rolled-entity-projection` made their conventions
reflexes: a lint rule that fires at authoring time, a one-line decision rule in
the docs agents actually read, and a full burndown of the existing violations
so the rule lands at zero.

**User decisions:** exemptions via inline `eslint-disable` + named reason (no
container heuristic); migrate ALL standing-surface sites now, using Opus
subagents.

## Part 1 — Lint rule `data-view/no-adhoc-row-list`

New folder `plugins/primitives/plugins/data-view/lint/` (first lint contribution
from this plugin; sits beside the existing `check/`). No new `package.json` —
`lint/` shares the plugin's existing one. Discovery is automatic: the next
`./equin build` regenerates `lint.generated.ts` and the rule is enforced
as `error` repo-wide (both by root `eslint.config.ts` and the unified
`type-check` check — same `buildLintConfig`, can never drift).

### Files

- `plugins/primitives/plugins/data-view/lint/no-adhoc-row-list.ts` — the rule
- `plugins/primitives/plugins/data-view/lint/no-adhoc-row-list.test.ts` — RuleTester (bun:test)
- `plugins/primitives/plugins/data-view/lint/index.ts` — contribution:

```ts
export default {
  name: "data-view",                       // rule id: data-view/no-adhoc-row-list
  rules: { "no-adhoc-row-list": noAdhocRowList },
  ignores: {
    "no-adhoc-row-list": [
      // Permanent sanctioned homes — these primitives ARE the row-rendering machinery.
      "plugins/primitives/plugins/data-view/**",
      "plugins/primitives/plugins/tree/**",
      "plugins/reorder/plugins/editor/**",
    ],
  },
};
```

### Detection (mirror `no-hand-rolled-entity-projection`'s philosophy)

Name-based, NO import/type resolution — contributed rules run as `error`, so
favor **false negatives over false positives** (an aliased `import { Row as R }`
evades it; accepted precedent, not a gap).

Visitor: `CallExpression` where

1. `callee` is a non-computed `MemberExpression` with property name `map`;
2. `arguments[0]` is an arrow/function expression;
3. any **returned expression** of that callback resolves to a `JSXElement`
   whose opening element name is the bare identifier `Row`.

"Returned expression" resolution:
- arrow expression body → that expression;
- block body → every top-level-of-this-function `ReturnStatement` argument
  (do not descend into nested functions);
- unwrap `ConditionalExpression` (check both branches), `LogicalExpression`
  (right operand), and TS `as` wrappers.
- A fragment/wrapper element *containing* a Row is deliberately NOT flagged
  (false negative by design — keeps grouped/bespoke compositions out).

Only `Row` — not `SectionHeaderRow` (headers aren't data rows).

Report once per matched `JSXElement`, single `messageId`, no autofix. Message
text (prescriptive, names the fix and the escape hatch, mirroring
`no-adhoc-row`'s style):

> Mapping data into `<Row>` hand-rolls a data list. A collection of homogeneous
> domain records is a DataView surface — declare a `FieldDef[]` schema and
> render `<DataView views={["list"]}>` (search/filter/sort/groupBy/item-actions
> come free; see `plugins/primitives/plugins/data-view/CLAUDE.md`). If this is
> genuinely transient chrome (a menu, picker, tab strip, or typeahead), keep
> `Row` and add
> `// eslint-disable-next-line data-view/no-adhoc-row-list -- <reason>`.

### Test

Co-located `no-adhoc-row-list.test.ts`, `RuleTester` at **module top level**
(never inside `test()` — RuleTester drives its own describe/it), parser
`@typescript-eslint/parser` with `ecmaFeatures: { jsx: true }`. Copy the harness
shape from `plugins/primitives/plugins/css/plugins/surface/lint/no-adhoc-surface.test.ts`.

Valid cases: map returning `<div>`/other component; map returning fragment
wrapping Row; `Row` outside a map; `.map` on non-callback arg; nested function
returning Row inside a map callback that itself returns something else.
Invalid cases: arrow expression body `items.map(i => <Row …/>)`; parenthesized;
block body with `return <Row/>`; conditional `i.ok ? <Row/> : null`.

Run: `bun test plugins/primitives/plugins/data-view/lint/no-adhoc-row-list.test.ts`.

## Part 2 — Decision-rule docs

Four small edits; the rule text is the same one-liner everywhere:

1. **Root `CLAUDE.md`** — new bullet in "Coding Style" (after the
   fail-loudly/absorbable-failure cluster):
   > **Collections of domain records are DataViews.** Rendering a homogeneous
   > set of domain records (rows from DB / live-state / config) is a
   > `data-view` surface (`views={["list"]}` minimum) — never a hand-rolled
   > `.map()` of `<Row>`. `Row`+map is only for transient chrome (menus,
   > pickers, tab strips), annotated
   > `// eslint-disable-next-line data-view/no-adhoc-row-list -- <reason>`.
   > Enforced by lint.

2. **`.claude/skills/css/SKILL.md`** — one line in the "Pick a container"
   paragraph (§ Layout primitives): *"a list of domain records → **`DataView`**
   (`data-view/no-adhoc-row-list` bans `.map`→`<Row>`), not a hand-rolled Row
   stack"*, plus append the rule to the `Row` bullet.

3. **`plugins/primitives/plugins/css/plugins/row/CLAUDE.md`** — short section
   "Row is not a data list" above the autogen block: Row is for single rows and
   transient chrome; mapping domain records into Row is banned by
   `data-view/no-adhoc-row-list`; point to data-view.

4. **`plugins/primitives/plugins/data-view/CLAUDE.md`** — short "Enforcement"
   note documenting the rule + the inline-disable escape hatch, next to the
   existing `configs-authored` description.

## Part 3 — Migration burndown (Opus subagents, parallel)

Audit verdicts. Every migration follows the shared recipe below; every EXEMPT
site gets the inline disable with the stated reason. **Zero grandfather
entries** — the rule lands with the repo clean.

### MIGRATE (6 surfaces, one Opus agent each)

| # | Site | Shape |
|---|------|-------|
| M1 | `apps/studio/compositions` `CompositionList` (`compositions-view.tsx`) | `list` view, groupBy `category` (enum: profile/app/subsystem/pack/other), fields: name (text, primary), category, entry/contributor/extends counts (int). Row click = `selectDraft`. Replaces the hand-rolled `CATEGORY_GROUPS` reduction. The compare-mode `CompositionPicker` in the same file stays Row+map with a disable (single-select control). |
| M2 | `apps/studio/release` history (`release-launcher.tsx` → `ReleaseHistoryList`) | `list` view over `releaseHistoryResource` runs: composition (text), target (enum), status (enum), startedAt (date). Row click opens detail pane. Unbounded growth → gains filter/sort. |
| M3 | `debug/boot-profile` (`boot-profile-list.tsx`) | `list` view over saved snapshots: worktree (text), createdAt (date). Row click opens detail. |
| M4 | `build` history pane (`build-popover-content.tsx`) | **Split**: the standing pane variant (`buildPane`) becomes a DataView (trigger/status enum, timing date fields); the 10-row popover excerpt keeps Row+map with a disable (`-- popover excerpt of the build pane DataView`). |
| M5 | `conversations/agents` `agent-launches.tsx` | `list` view over DB-backed launch history in the agent detail pane; row click opens conversation. |
| M6 | `page/links` `backlinks.tsx` | `list` view over backlink page records in the page "Linked from" section. |

`tasks/task-events` (pushes + attempts→conversations) is **deferred**: its rows
are heterogeneous and nested (three record types), so it is not a mechanical
DataView fit — it gets a disable (`-- heterogeneous nested activity feed;
DataView migration needs its own design`) and a filed follow-up task via
`add_task`. Same for `plugin-meta/plugin-view/sub-plugins` (recursive tree —
candidate for the data-view `tree` view, own design) if the rule flags it.

### EXEMPT — inline disable + reason (annotated by the main agent, not subagents)

| Site | Reason string (after `--`) |
|------|------|
| `apps/browser/start-page` recents-section | start-page quick-access widget, bounded recent window |
| `page/inline-date` | caret typeahead menu |
| `apps/studio/compositions` entry-editor + CompositionPicker | add-item search popover / single-select picker control |
| `fields/date/filter` | fixed 3-preset option list inside DataView's own filter widget |
| `debug/zero-test` | frozen Zero pilot harness, slated for deletion |
| `debug/trace/pane` trace-detail AlsoInWindow | derived related-traces strip in a detail pane; Events tab is the DataView |
| `apps/pages/trash` | modal trash dialog; revisit if Trash becomes a pane |
| `primitives/folder-picker` | directory drill-down picker popover |
| `search/quick-find` | Cmd-K transient search overlay |
| `apps/browser/bookmarks` + `tabs` | browser chrome strips (bookmarks bar, tab strip) |
| `history/dialog` version-history | bespoke timeline+preview dialog interaction |
| `tasks/task-events` | heterogeneous nested activity feed (task filed) |
| plus any residue the full lint run surfaces (ground truth pass below) | judge per the decision rule |

### Shared migration recipe (given verbatim to each Opus agent)

1. Read `plugins/primitives/plugins/data-view/CLAUDE.md` (consumer contract:
   config mode, placement/no-own-scroll, `defineDataView`, `configs-authored`)
   and ONE existing simple consumer as the working precedent — e.g.
   `plugins/debug/plugins/reports` or `plugins/apps/plugins/prototypes` (find
   via `docs/plugins-details.md`). Mirror the precedent's shape byte-for-byte.
2. In the plugin's `web/`: `defineDataView("<plugin>.<surface>")` marker,
   `FieldDef[]` schema, `<DataView storageKey views={["list"]} …>` with
   `onRowActivate` (and `defineItemActions` only if the old UI had row
   actions). DataView is natural-height — the enclosing pane must provide the
   single scroll (`PaneChrome` body already does).
3. Hand-author the views config at `config/<plugin-path>/<id>.jsonc`
   (`{ "views": [ { "name": "...", "view": { "type": "list", … } } ] }`) — the
   `data-view:configs-authored` check fails without it. GroupBy/sort live in
   the view blob.
4. Delete the replaced Row-map code. Do NOT add eslint-disables in migrated
   surfaces. Do NOT run `./equin build` (the main agent builds once at
   the end). Do NOT commit.
5. Report: files touched, config path authored, any contract friction hit.

Agents run in parallel in THIS worktree — the six sites are in disjoint
plugins, no file overlap (M1's file also carries an EXEMPT disable for
CompositionPicker; that annotation belongs to M1's agent to avoid two writers).

## Execution order

1. Main agent: lint rule + test + `lint/index.ts` (Part 1), doc edits (Part 2).
2. `./equin build` (regenerates `lint.generated.ts`; also
   `data-views.generated.ts` later) — then run the repo lint to get the
   **ground-truth violation list** (grep was an approximation):
   `bunx eslint 'plugins/**/web/**/*.tsx' 2>&1 | grep no-adhoc-row-list`.
3. Dispatch M1–M6 Opus agents in parallel (single message, six Agent calls,
   `model: "opus"`).
4. Main agent: apply inline disables to all EXEMPT sites + any residue from
   step 2; file the `task-events` / `sub-plugins` follow-up tasks via
   `mcp add_task`.
5. `./equin build` once; fix fallout.

## Verification

- `bun test plugins/primitives/plugins/data-view/lint/no-adhoc-row-list.test.ts` — rule unit tests green.
- `./equin check` — `type-check` (rule active repo-wide, zero violations),
  `data-view:configs-authored` (all six new configs authored),
  `data-views-in-sync`, `plugins-doc-in-sync` all pass.
- Negative probe: temporarily add `items.map(i => <Row/>)` to any web file →
  `bunx eslint` flags it with the new rule id; revert.
- `./equin build` deploys; then scripted Playwright
  (`bun e2e/screenshot.mjs`) against `http://<worktree>.localhost:9000` for
  each migrated surface: `/studio/compositions` (grouped list renders, clicking
  a composition loads the draft + opens Explorer), Studio → Release (history
  list + detail opens), Debug → Boot Profiles, build pane, an agent detail
  (launches), a page with backlinks. Confirm the DataView toolbar
  (search/view-switcher) is present and row clicks preserve the old behavior.

## Critical files

- `plugins/primitives/plugins/data-view/lint/{index,no-adhoc-row-list,no-adhoc-row-list.test}.ts` (new)
- Precedents to copy: `plugins/framework/plugins/tooling/plugins/lint/plugins/entity-projection-safety/lint/no-hand-rolled-entity-projection.ts` (map-callback AST walk, name-based matching), `plugins/primitives/plugins/css/plugins/row/lint/no-adhoc-row.ts` (message style, index shape), `plugins/primitives/plugins/css/plugins/surface/lint/no-adhoc-surface.test.ts` (RuleTester harness)
- Registration machinery (read-only): `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts`
- Docs: `CLAUDE.md` (root), `.claude/skills/css/SKILL.md`, `plugins/primitives/plugins/css/plugins/row/CLAUDE.md`, `plugins/primitives/plugins/data-view/CLAUDE.md`
- Migration sites: see tables above.
