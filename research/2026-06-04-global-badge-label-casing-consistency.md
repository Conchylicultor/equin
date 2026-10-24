# Badge label casing consistency

## Context

Badge labels are cased inconsistently across the app. Some are proper-cased
(`"Opus 4.8"`), some sentence-case (`"In progress"`), some all-lowercase
(`"working"`, `"disconnected"`), and some are force-transformed in CSS
(`capitalize` on a raw CLI string `"claude-opus-4-8"` → mangled
`"Claude-opus-4-8"`; `uppercase tracking-wider` "eyebrow" chips copy-pasted 4×).

Root cause: the `Badge` primitive renders `children` **verbatim**, so casing is
decided independently at ~50 call sites, by string literals, ad-hoc
`.replace(/_/g, " ")` helpers, and CSS `text-transform` classes. There is no
shared formatter and nothing prevents a new site from inventing its own casing.

Intended outcome — **one house rule, enforced structurally**:

- **Derived/status labels** (computed from enum keys) → **sentence case**, via a
  single `formatStatusLabel()` formatter. This is the only sanctioned
  identifier→label transform.
- **Proper nouns / verbatim content** (model names like `"Opus 4.8"` from the
  model registry, user-typed category names, counts) → passed through as-is.
- **Casing lives in the content, never in CSS.** A lint rule bans
  `capitalize`/`uppercase`/`lowercase` on `<Badge className>` so the whole class
  of "fix casing in CSS at the call site" fails `./equin check`. If
  something genuinely must be all-caps (e.g. the `"BYPASS ACTIVE"` alarm chip),
  it is authored as a literal caps string — auditable in the data.

There is **no** legitimate reason for the `uppercase` eyebrow-chip style; it is
arbitrary per-site styling, so it is removed rather than promoted to a primitive.

## Design

### 1. New formatter primitive — `formatStatusLabel`

New file `plugins/primitives/plugins/badge/web/internal/format-label.ts`,
re-exported from `plugins/primitives/plugins/badge/web/index.ts`.

```ts
/**
 * THE sanctioned identifier→label transform. Converts an enum/identifier key
 * (snake_case, kebab-case, single word) to a sentence-case display label:
 * separators → spaces, first character upper, the rest lower.
 *   "in_progress" → "In progress"   "need_action" → "Need action"
 *   "working"     → "Working"       "general-purpose" → "General purpose"
 * Proper nouns (model names, user input) must NOT go through this — pass them
 * verbatim.
 */
export function formatStatusLabel(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").trim().toLowerCase();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : spaced;
}
```

Lives in the `badge` plugin so the formatter and the lint rule that enforces its
use sit in one cohesive "badge labels" home. Pure function, web-safe, no React.

### 2. Lint rule — `no-badge-text-transform`

New file `plugins/primitives/plugins/badge/lint/no-badge-text-transform.ts`,
registered in `plugins/primitives/plugins/badge/lint/index.ts` alongside the
existing `no-adhoc-chip`. The root `eslint.config.ts` auto-discovers it and
enables it repo-wide as `error` (run by the `eslint` built-in check).

- Fires on a JSX element whose tag name is `Badge` with a `className` attribute
  whose class tokens include `capitalize`, `uppercase`, or `lowercase` (also
  responsive/variant-prefixed forms like `sm:uppercase` — match token suffix).
- Reuse the `collectTokens` className-walking approach from `no-adhoc-chip.ts`
  (handles bare strings, `cn()`, template literals, ternaries).
- Does **not** police the primitive's own internal markup (it renders `<As>`,
  not `<Badge>`), nor literal caps strings in `children`.
- Message: casing must live in the content, not CSS — use `formatStatusLabel`
  for enum-derived labels, the model registry label for model names, or author
  a literal string for an intentional all-caps alarm. Escape hatch:
  `// eslint-disable-next-line badge/no-badge-text-transform -- <reason>`,
  consistent with `no-adhoc-chip`'s philosophy.

### 3. Consolidate duplicated attempt-status maps → new `attempt-status` plugin

`ATTEMPT_STATUS_CLASSES` + `ATTEMPT_STATUS_LABELS` are duplicated verbatim in two
files. Mirror the `task-status` precedent byte-for-byte: new sub-plugin
`plugins/tasks/plugins/attempt-status/` (web-only) exporting:

- `ATTEMPT_STATUS_META: Record<Attempt["status"], { badgeClassName: string }>` —
  the color classes only (labels are pure mechanical sentence-case, derived).
- `AttemptStatusBadge({ status })` → `<Badge colorClass={meta.badgeClassName}>{formatStatusLabel(status)}</Badge>`.

Both consumers import `AttemptStatusBadge` and delete their local maps:

- `plugins/tasks/plugins/task-events/web/components/task-events.tsx`
- `plugins/active-data/plugins/task/web/components/task-card.tsx`

(`active-data/task` → `@plugins/tasks/plugins/attempt-status/web` is a legal
cross-plugin barrel import.)

### 4. Migrate the divergent sites

**Content-casing → `formatStatusLabel`:**

- `…/status/web/components/status-badge.tsx` — `prettify()` becomes
  `STATUS_LABELS[status] ?? formatStatusLabel(status)`; the `gone` override value
  becomes `"Disconnected"`. Result: `"Working"`, `"Waiting"`, `"Starting"`.
- `plugins/debug/plugins/memory/web/components/memory-panel.tsx` — `TYPE_BADGE`
  loses its `label` field (keep `classes`); render
  `formatStatusLabel(type)` (`"ref"`→`"Reference"`, etc.). `displayName(name)`
  becomes `formatStatusLabel(name.replace(/\.md$/, ""))`.
- `plugins/review/plugins/plugin-changes/web/components/plugin-change-card.tsx`
  — drop `uppercase tracking-wider`; render `formatStatusLabel(plugin.status)`
  (`"Added"` / `"Modified"`).
- `…/task-tools/web/components/task-list-tool-view.tsx:37` — drop `uppercase`;
  render `formatStatusLabel(t.status)`.

**Model names → registry label (verbatim, no CSS):** replace
`<Badge className="… capitalize">{model}</Badge>` with the
`MODEL_REGISTRY[normalizeModel(model)].label` (`"Opus 4.8"`). Sites:

- `…/tool-call/plugins/agent/web/components/agent-tool-view.tsx:21-29` (`ModelBadge`)
- `…/tool-call/plugins/workflow/web/components/workflow-node-card.tsx:56-60`
- `…/tool-call/plugins/workflow/web/components/workflow-node-pane.tsx:50`

(These already import from `model-provider/core`; switch from `MODEL_TIERS` raw
display to the registry label. Keep `familyClass` colors.)

**Eyebrow chips → drop `uppercase tracking-wider`, content follows the house rule:**

- `agent-tool-view.tsx:31-37` (`MetaBadge`) — author readable sentence-case
  literals: `run_in_background` → `"Background"`, `isolation` → `"Worktree"`.
- `workflow-node-card.tsx:10-16` (`MetaChip`) — `formatStatusLabel` on
  enum-derived content (`agentType` → `"General purpose"`, `isolation` →
  `"Worktree"`, literal `"Schema"`).
- `workflow-tool-view.tsx:108,113` — drop `uppercase tracking-wider`; composed
  count strings (`"3 phases"`, `"3 agents"`) stay verbatim.

After migration, **zero** `<Badge>` in the repo carries a `text-transform`
class, so the new lint rule is green.

## Critical files

| Action | Path |
|---|---|
| New formatter | `plugins/primitives/plugins/badge/web/internal/format-label.ts` (+ barrel export) |
| New lint rule | `plugins/primitives/plugins/badge/lint/no-badge-text-transform.ts` (+ `lint/index.ts`) |
| New plugin | `plugins/tasks/plugins/attempt-status/` (barrel + component + `package.json` + `CLAUDE.md`) |
| Migrate | `…/status/web/components/status-badge.tsx` |
| Migrate | `plugins/debug/plugins/memory/web/components/memory-panel.tsx` |
| Migrate | `plugins/review/plugins/plugin-changes/web/components/plugin-change-card.tsx` |
| Migrate | `…/tool-call/plugins/agent/web/components/agent-tool-view.tsx` |
| Migrate | `…/tool-call/plugins/workflow/web/components/workflow-{tool-view,node-card,node-pane}.tsx` |
| Migrate | `…/tool-call/plugins/task-tools/web/components/task-list-tool-view.tsx` |
| Consolidate | `plugins/tasks/plugins/task-events/web/components/task-events.tsx` |
| Consolidate | `plugins/active-data/plugins/task/web/components/task-card.tsx` |

Reuse: `collectTokens` (`badge/lint/no-adhoc-chip.ts`), `STATUS_META`/precedent
(`tasks/plugins/task-status`), `MODEL_REGISTRY` + `normalizeModel`
(`conversations/plugins/model-provider/core`).

## Out of scope (noted, not changed)

- `task-status` `STATUS_META` keeps its authored labels — they are the canonical
  display names and already match `formatStatusLabel`; leaving them authored
  preserves intentional-override capability for the source of truth.
- Non-badge `.replace(/_/g, " ")` uses (avatar icon names, `tasks-button` tooltip
  `title=`) are not badge labels; left alone.

## Verification

1. `./equin build` — runs the `eslint` check; the new
   `no-badge-text-transform` rule must pass (proves every Badge site migrated)
   and `migrations-in-sync`/`plugins-doc-in-sync` stay green (new plugin adds
   no tables; regenerate docs).
2. Scripted Playwright on `http://att-1780580096-fffe.localhost:9000`:
   - Conversation toolbar status badge reads **`Working`** (was `working`),
     gone conversation reads **`Disconnected`**.
   - Open a conversation with an Agent/Workflow tool call: model chip reads
     **`Opus 4.8`** (was `claude-opus-4-8`), meta chips read **`Worktree`** /
     **`General purpose`** (was `WORKTREE` / `GENERAL-PURPOSE`).
   - Task detail → events: attempt badges via `AttemptStatusBadge` render
     identically to before (`In progress`, `Pushed`, …).
   - Review pane → plugin-changes card: status badge reads **`Added`** /
     **`Modified`** (was `ADDED` / `MODIFIED`).
   - Debug → Memory: type badges read **`Reference`**, **`Feedback`**, … .
3. Grep guard: `rg --multiline '<Badge\b[^>]*(capitalize|uppercase|lowercase)' plugins`
   returns nothing.
