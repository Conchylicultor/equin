# Close the transitive / indirect cross-plugin re-export gap in `plugin-boundaries`

## Context

The `plugin-boundaries` check forbids a plugin's barrel (`index.ts`) from
re-exporting another plugin's symbols (`cross-plugin-reexport` rule). The rule's
intent is absolute: *"never proxy another plugin's symbols through your own
barrel — re-exports hide the real dependency."* The root `CLAUDE.md`'s own
**Wrong** example is a parent re-exporting a descendant (`tasks/web` proxying
`task-draft-form`), so there is deliberately **no umbrella-aggregation carve-out**.

But the rule only inspects the barrel's *own statements* and only the
`export … from "@plugins/…"` shape. Two equivalent constructs slip under it:

1. **Indirect re-export chain.** The barrel does `export { X } from "./types"`,
   and `./types` (an internal file, never scanned as a barrel) does
   `export { X } from "@plugins/other/runtime"`. Net effect identical; invisible
   to the rule. This is **actively exploited** — `plugins/tasks/core/types.ts`
   carries a comment documenting it as a deliberate workaround.
2. **Import-then-reexport.** A file does
   `import { X } from "@plugins/other/runtime"; export { X };`. The bare
   `export { X }` has no `from`, so the rule never sees a cross-plugin specifier
   — even **directly in a barrel**. This is also a real existing leak.

The fix: make the rule follow a barrel's surfaced names to their true origin and
flag any whose origin plugin differs from the barrel's own — catching both
shapes at any depth — then migrate the existing offenders to import from source.

### Why name-level (not file-level) resolution is required

A crude "any cross-plugin re-export in a barrel-reachable file = violation"
heuristic **false-positives**. Three internal files re-export a foreign symbol
that their barrel does **not** surface:
- `conversation-category/web/internal/use-category-avatars.ts` re-exports
  `AvatarSpec`, but the barrel only surfaces `useCategoryAvatars` (local).
- `attachments/server/internal/paths.ts` re-exports `ATTACHMENTS_DIR`, never
  surfaced by the barrel.
- `sonata/.../piano-roll/web/components/geometry.ts` re-exports `isBlackPitch`,
  not surfaced.

So the check must track **which names the barrel actually surfaces** and resolve
each name's provenance — not merely whether a reachable file touches a foreign
plugin.

## Current implementation (what changes)

All in `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/index.ts`:

- The `cross-plugin-reexport` rule is an inline branch of `checkBarrelPurity`
  (lines ~573–591): it runs `extractFromSpecifier` on each `export …` statement
  and only fires when the specifier is `@plugins/<p>/<runtime>` and `<p>` differs
  from the barrel's plugin. Relative specifiers (`./types`) and bare
  `export { X }` are ignored.
- Reusable helpers already present: `stripComments`, `splitTopLevelStatements`,
  `extractFromSpecifier`, `resolveImport` (longest-prefix `@plugins/…` →
  `{pluginPath, suffixHead, tail}`), `pluginForPath`, `runtimeNames`,
  `REEXPORT_EXCEPTIONS` (temporary-migration allowlist, keyed
  `${plugin}/${runtime} -> ${specifier}`).
- No module graph is prebuilt; each rule re-reads files. There are **no tests**
  for this check.

## Design

### 1. Name-carrying provenance resolver

Replace the inline branch with a dedicated, **pure** resolver so it is unit
testable in isolation (no git / disk-walk dependency):

**New file** `check/reexport-provenance.ts` exporting
`collectForeignReexports({ barrelRel, ownPlugin, runtime, pluginSet, readFile }): Violation[]`
where `readFile(relPath) => string | null` is injected (real impl wraps
`safeRead`; tests pass a fixture map).

Parse each file (via shared helpers) into:
- `imports: Map<localName, { spec, typeOnly }>` — from `import { a as b, type c } from "spec"` and `import * as N from "spec"`.
- `fromReexports: { exported, local, spec, typeOnly }[]` — `export { a as b } from "spec"`.
- `bareReexports: { exported, local, typeOnly }[]` — `export { a as b }` (no `from`).
- `wildcardFrom: spec[]` — `export * from "spec"` / `export * as N from "spec"`.
- `localExports: Set<name>` — names declared/owned in this file.

`resolveOrigin(file, name, visited) → { plugin } | "LOCAL" | "EXTERNAL"`:
- Name from a **fromReexport**:
  - `spec` is `@plugins/<p>/<runtime>` → origin plugin `<p>`.
  - `spec` is relative → resolve to a file **within `ownPlugin`** (try `.ts`,
    `.tsx`, `/index.ts`); recurse `resolveOrigin(target, local)`. If it escapes
    the plugin, stop (R8 `relative-cross-plugin` owns that).
  - external bare module → `EXTERNAL`.
- Name from a **bareReexport** → look up `local` in this file's `imports`:
  - imported from `@plugins/<p>/<runtime>` → origin `<p>`.
  - imported from relative → recurse into target for that imported name.
  - not imported (in `localExports`) → `LOCAL`.
- Name matched only by `wildcardFrom`:
  - cross-plugin foreign `spec` → treat as **FOREIGN** (conservative; can't
    enumerate names without resolving the other barrel — none exist today).
  - relative `spec` → recurse via the wildcard target.

For the **barrel**: for every surfaced name (its `fromReexports` +
`bareReexports` + any `wildcardFrom`), call `resolveOrigin`. If the result is a
plugin `≠ ownPlugin`, push a `cross-plugin-reexport` violation. Message names the
symbol, the indirection chain, and the ultimate specifier; `fix` tells the
consumer to import from the source barrel directly. Honor `REEXPORT_EXCEPTIONS`
keyed `${ownPlugin}/${runtime} -> ${ultimateSpecifier}`.

Guards: `visited` set (cycle safety); type-only and value re-exports both count
(proxying foreign *types* is equally forbidden — the current rule already flags
`export type {…} from "@plugins/…"`).

### 2. Share the parse helpers

Move `stripComments`, `splitTopLevelStatements`, `extractFromSpecifier` (and a
new binding-list parser that extracts `{ a as b, type c }` → names+aliases) into
a small `check/parse.ts` imported by both `index.ts` and
`reexport-provenance.ts`. `index.ts` keeps calling `collectForeignReexports`
from the R3 barrel loop in place of the deleted inline branch; the rest of
`checkBarrelPurity` (barrel purity, wildcard-in-barrel) is unchanged.

### 3. Migrate the 7 existing offenders (migrate all now)

Repoint consumers to the **true source barrel**, then delete each proxy hop. The
`REEXPORT_EXCEPTIONS` set stays empty.

| Barrel | Foreign names | True source | Consumers | Action |
|---|---|---|---|---|
| `tasks/core` | `Attempt`, `AttemptWithConversations`, `ConversationSummary`, `Push`, `Task`, `TaskListItem` | `@plugins/tasks/plugins/tasks-core/core` | ~25 | delete `tasks/core/types.ts`; drop the `export … from "./types"` block in the barrel; repoint type imports |
| `conversations/core` | `conversationsResource`, `ConversationListPayload` | `@plugins/tasks/plugins/tasks-core/core` | 5 | stop re-exporting them from `core/resources.ts` + barrel (keep local `ConversationEntry`); repoint consumers |
| `conversations/server` | `ConversationStatusSchema`, `ConversationStatus` | `@plugins/tasks/plugins/tasks-core/core` | 0 | drop the cross-plugin re-export line in `server/status.ts` + barrel (keep local `isActiveStatus`, `hasLiveProcess`) |
| `conversation-view/web` | `Conversation`, `ConversationRecord` | `@plugins/tasks/plugins/tasks-core/core` | 0 | drop the re-export in `web/slots.ts` + barrel |
| `checks/core` | `Check`, `CheckResult` | `@plugins/framework/plugins/tooling/core` | 0 | drop from `core/types.ts` + barrel |
| `conversation-ui/item/web` | `formatRelativeTime` | `@plugins/primitives/plugins/relative-time/web` | 0 | drop the bare `export { formatRelativeTime }` in `components/conversation-item.tsx` + barrel line |
| `codegen/core` | `PluginNode` | `@plugins/plugin-meta/plugins/plugin-tree/core` | 0 | drop the bare `export { type PluginNode }` in `core/docgen.ts` + barrel line |

Consumer-import sites are found per symbol with
`rg 'SYMBOL' $(rg -l 'from "@plugins/<barrel>"' plugins)`. The `tasks/core`
migration is the only sizable one; several consumers there import *both* proxied
types and `tasks/core`-owned functions (e.g. `createTask`) — split those into two
import lines (types from `tasks-core/core`, functions from `tasks/core`).

### 4. Docs

- Update `plugins/.../plugin-boundaries/CLAUDE.md` to state the rule follows
  internal re-export chains and import-then-reexport (provenance-based), with no
  umbrella carve-out.
- Tighten the root `CLAUDE.md` "No cross-plugin re-exports" bullet to say
  *indirect* proxying (through internal files or import-then-reexport) is caught
  the same as direct.

## Files to modify

- `plugins/framework/plugins/tooling/plugins/checks/plugins/plugin-boundaries/check/index.ts` — wire in `collectForeignReexports`; remove inline branch.
- **new** `…/plugin-boundaries/check/reexport-provenance.ts` — pure resolver.
- **new** `…/plugin-boundaries/check/parse.ts` — shared parse helpers + binding-list parser.
- **new** `…/plugin-boundaries/check/reexport-provenance.test.ts` — bun:test.
- `…/plugin-boundaries/CLAUDE.md` and root `CLAUDE.md` — doc updates.
- Migration: `tasks/core/{index.ts,types.ts(delete)}`, `conversations/core/{index.ts,resources.ts}`, `conversations/server/{index.ts,status.ts}`, `conversation-view/web/{index.ts,slots.ts}`, `checks/core/{index.ts,types.ts}`, `conversation-ui/.../item/web/{index.ts,components/conversation-item.tsx}`, `codegen/core/{index.ts,docgen.ts}`, plus the ~30 consumer import sites (tasks/core ~25, conversations/core 5).

## Verification

1. **Unit test** the resolver (`bun test …/reexport-provenance.test.ts`) with
   fixtures covering: direct from-reexport (flagged), indirect chain (flagged),
   import-then-bare-reexport in a barrel and via an internal file (flagged),
   name-level precision — internal file re-exports a foreign name the barrel does
   **not** surface (NOT flagged, the `AvatarSpec` case), relative export-from to a
   local symbol (NOT flagged), parent→descendant proxy (flagged, no carve-out),
   and an exception entry suppressing a flagged case.
2. **Regression-proof the gap:** temporarily restore one proxy (e.g. recreate
   `tasks/core/types.ts`) and confirm `./equin check plugin-boundaries`
   now **fails** on it (it passed before this change), then revert.
3. After migration, `./equin check plugin-boundaries` **passes** with
   `REEXPORT_EXCEPTIONS` empty.
4. `./equin build` — `type-check` passes with all repointed imports
   resolving (no dangling imports from deleted proxies).
