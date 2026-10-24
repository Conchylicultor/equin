# Deprecate `defineCommand`; move toast to a self-contained store-host plugin

**Date:** 2026-07-01
**Category:** global (framework/web-sdk + shell + improve + command-palette + composition)
**Status:** proposed

## Context

Every gateway-served app composition `extends` the `served-baseline` subsystem
(`plugins/plugin-meta/plugins/composition/core/config.ts`), which force-includes
`infra.health`. Health's `Core.Root` watchers dispatch `ShellCommands.Toast(...)`.
But the plugin that *registers* the `shell.toast` handler — `shell/plugins/toaster` —
is a soft `Core.Root` contributor that **nothing imports**, so the closure engine
(which only follows import + slot-contribution edges) cannot pull it into any app
closure. Result: in a filtered composition (observed flooding the **sonata release
console** during a WS reconnect storm), health fires a toast, `handlers` is empty,
and `web-sdk/core/commands.ts:15` throws `No handler for command "shell.toast"` as
an **uncaught error**.

Two facets:
- **(a)** the toast *handler* is absent from compositions that include the toast
  *dispatcher* → user-facing toasts are silently lost.
- **(b)** dispatching a command with no handler **throws uncaught** rather than
  degrading — a best-effort toast should never surface as an uncaught error.

### Why this is a `defineCommand` problem, not a toast problem

Investigation (two Explore passes) showed `defineCommand` is **vestigial**: 4
definitions, ~8 call sites, and decaying —

- `command-palette.open` / `.toggle` — handler registered, **zero callers** (dead).
- `improve.openWithText` — 2 callers.
- `shell.toast` — 6 raw callers, but the dominant path is a plain wrapper
  `toast()` in `shell/plugins/notifications` (imported by **38 files**).

Everything else uses idiomatic decoupling instead: **`Pane.define`/`.open()`** for
views (91 defines; the old `shell.open-pane` *command* was deleted for it),
**module-level stores + exported setters** (`useSyncExternalStore`, e.g.
`pinAsRoot`, `setActiveComposition`) for fire-and-forget UI actions,
**`resourceDescriptor.notify()`/`useResource`** (65 resources / 213 consumers) for
"announce a fact", and **`defineEndpoint`** (277) across the client↔server
boundary. `imperative-dialog`'s `openDialog()` is literally described in-code as
*"the toaster pattern for dialogs"* — a store-backed queue hosted once via
`Core.Root`, exposed as a plain function that **degrades to a no-op when no host
is mounted**. The toaster is the one feature still on the fragile handler-stack.

**Decision (user-approved):** deprecate `defineCommand` **entirely**. Migrate all
4 usages to the idiomatic replacement and remove the primitive + its docgen facet.
Toast lands as a self-contained plugin **`shell/plugins/toast`** (Option A) — not
`primitives/toast`, because its host depends *up* on `apps-core` (chrome theme
scope) and `ui/theme-engine`, which a low-level primitive must not.

## Approach

Phase 1 delivers the bug fix (facets a + b). Phase 2 completes the deprecation.

---

### Phase 1 — Migrate the 4 commands + fix `served-baseline`

#### 1a. Toast → new `shell/plugins/toast` (store-host plugin)

Create a self-contained plugin (mirrors `imperative-dialog`'s shape):

- `plugins/shell/plugins/toast/package.json` — `@singularity/plugin-shell-toast`,
  `private`, and **declare `"sonner": "^2.0.7"`** (today only `plugins/shell/package.json`
  declares it; the new workspace needs its own).
- `plugins/shell/plugins/toast/core/index.ts` — move the contract out of the shell
  barrel: `export type ToastVariant = …` and `export interface ToastArgs { title?, description, variant? }`.
- `plugins/shell/plugins/toast/web/internal/show-toast.tsx` — the **old handler body,
  verbatim**, as a plain function (plus the `ClickToDismiss` helper moved here):
  ```tsx
  export function showToast({ title, description, variant }: ToastArgs): void {
    const message = title ?? description;
    const fn = variant && variant !== "default" ? sonnerToast[variant] : sonnerToast;
    fn(<ClickToDismiss…><ContentScope fill={false}>{message}</ContentScope></ClickToDismiss>, {…});
  }
  ```
  (`sonnerToast` is sonner's global imperative API — callable from anywhere; if no
  `<Toaster/>` is mounted it enqueues with no renderer, i.e. a silent no-op. No throw.)
- `plugins/shell/plugins/toast/web/components/toaster-host.tsx` — the `<Sonner/>`
  renderer from `toaster-root.tsx` **minus** the `useHandler` (keeps `useColorMode`,
  `useChromeThemeScope`, the `data-theme-scope` wrapper).
- `plugins/shell/plugins/toast/web/index.ts`:
  ```ts
  export { showToast } from "./internal/show-toast";
  export { type ToastArgs, type ToastVariant } from "../core";
  export default { description: "…", contributions: [Core.Root({ component: ToasterHost })] };
  ```
- **Delete** `plugins/shell/plugins/toaster/` (whole plugin).
- **Delete** `plugins/shell/web/commands.ts`; in `plugins/shell/web/index.ts` remove
  the `export { Shell as ShellCommands, type ToastVariant, type ToastArgs } from "./commands";`
  line. Shell's barrel no longer carries the toast contract (resolves the earlier
  "leak into shell" concern).

**Migrate the 6 raw callers** `ShellCommands.Toast(x)` → `showToast(x)`
(`import { showToast } from "@plugins/shell/plugins/toast/web"`):
- `plugins/shell/plugins/notifications/web/internal/toast.ts:23` (the 38-importer
  wrapper — its public `toast()` and all 38 importers are **unchanged**; only this
  one internal line swaps; import `showToast` aliased to avoid the local `toast` name).
- `plugins/shell/plugins/notifications/web/components/bell-button.tsx:138`
- `plugins/infra/plugins/health/web/components/reconnect-watcher.tsx:14`
- `plugins/infra/plugins/health/web/components/wedge-watchdog.tsx:53`
- `plugins/debug/plugins/profiling/plugins/push/web/components/push-section.tsx:34`
- `plugins/conversations/plugins/conversation-view/plugins/push-profiling/web/components/push-profiling-pane.tsx:48`

#### 1b. `served-baseline` includes the toast host (facet a)

In `plugins/plugin-meta/plugins/composition/core/config.ts`, add `"shell.toast"` to
the `served-baseline` **entryPoints** (mirroring `infra.health` — forced
unconditionally, since health always dispatches). Update the adjacent comment.

#### 1c. `improve.openWithText` → module store

The command wakes a single always-mounted `ImproveButton` (`ActionBar.Item`; the
global action bar has two **mutually-exclusive** mount points → never double-mounted,
so a store is safe). Replace with a `useSyncExternalStore` store (mirrors
`plugin-meta/composition` store):
- `plugins/improve/web/internal/open-store.ts` — `openImproveWithText(text)` setter
  (stores `{ text, seq }`), `subscribeOpenRequest`, `getOpenRequest`.
- `plugins/improve/web/components/improve-button.tsx` — replace
  `Improve.OpenWithText.useHandler(...)` with a `useSyncExternalStore` read + effect
  that opens the popover with the requested text.
- `plugins/improve/web/index.ts` — export `openImproveWithText` (drop
  `ImproveCommands` / `OpenWithTextArgs`); remove the `./commands` import.
- **Delete** `plugins/improve/web/commands.ts`.
- Consumers → `openImproveWithText(text)`:
  - `plugins/screenshot/plugins/draw-on-app/web/components/draw-on-app-button.tsx:51`
  - `plugins/improve/plugins/element-picker/web/components/element-picker-button.tsx:10`

#### 1d. `command-palette.open` / `.toggle` → delete (dead)

Zero external callers; the palette opens via its own `Cmd+K` keydown listener
(local `setOpen`). 
- **Delete** `plugins/primitives/plugins/command-palette/web/commands.ts`.
- `command-palette-root.tsx` — remove the two `.useHandler` lines + the import
  (keydown listener already toggles).
- `command-palette/web/index.ts` — remove `export { CommandPaletteCommands }` + import.

---

### Phase 2 — Remove the `defineCommand` primitive + docgen facet

- **Delete** `plugins/framework/plugins/web-sdk/core/commands.ts`; in
  `core/index.ts` remove `export { defineCommand } from "./commands";`.
- **Delete** the test `plugins/framework/plugins/web-core/web/__tests__/commands.test.tsx`.
- **Delete** the commands facet subtree
  `plugins/plugin-meta/plugins/facets/plugins/commands/` (facet + render-diff /
  render-contributions / render-detail). Confirmed consumed **generically** (no
  cross-subtree importer) — Studio's Commands contribution table/detail sections
  disappear with zero consumer-code change (collection-consumer separation).
- `plugins/plugin-meta/plugins/barrel-import/core/internal/stubs.ts` — remove the
  `defineCommand` stub (~lines 138, 148).
- `plugins/plugin-meta/plugins/parse-utils/core/helpers.ts:131` — drop
  `"defineCommand"` from the `parseDefineGroup` builder union (helper stays; still
  used by `defineSlot`/`defineDispatchSlot`).
- `plugins/framework/plugins/web-sdk/CLAUDE.md` — remove the hand-written **Commands**
  section, the `commands.ts` file-structure line, and the "Inter-plugin
  communication — `defineCommand`…" bullet. (The autogen reference block updates on build.)

---

## Critical files

| File | Change |
|---|---|
| `plugins/shell/plugins/toast/**` | **new** plugin (core types + `showToast` + `ToasterHost` host) |
| `plugins/shell/plugins/toaster/**` | **delete** |
| `plugins/shell/web/commands.ts` | **delete** |
| `plugins/shell/web/index.ts` | drop `ShellCommands`/`ToastArgs` re-export |
| `plugins/plugin-meta/plugins/composition/core/config.ts` | add `shell.toast` to `served-baseline` entryPoints |
| `plugins/improve/web/{commands.ts→delete, index.ts, components/improve-button.tsx, internal/open-store.ts(new)}` | command → store |
| 2 improve consumers (draw-on-app, element-picker) | `openImproveWithText(text)` |
| `plugins/primitives/plugins/command-palette/web/{commands.ts→delete, index.ts, internal/command-palette-root.tsx}` | delete dead pair |
| 6 raw toast callers | `showToast(...)` |
| `plugins/framework/plugins/web-sdk/core/{commands.ts→delete, index.ts}` | remove primitive |
| `plugins/framework/plugins/web-core/web/__tests__/commands.test.tsx` | **delete** |
| `plugins/plugin-meta/plugins/facets/plugins/commands/**` | **delete** subtree |
| `plugins/plugin-meta/plugins/barrel-import/core/internal/stubs.ts` | remove `defineCommand` stub |
| `plugins/plugin-meta/plugins/parse-utils/core/helpers.ts` | drop `"defineCommand"` from union |
| `plugins/framework/plugins/web-sdk/CLAUDE.md` | remove Commands prose |

## Reuse (don't reinvent)

- **`imperative-dialog`** (`plugins/primitives/plugins/imperative-dialog/web/{index.ts,internal/store.ts}`)
  — the exact store-host shape to mirror for toast.
- **`plugin-meta/composition` store** (`web/internal/store.ts`) — the
  `useSyncExternalStore` + exported-setter pattern to mirror for improve.
- **`ClickToDismiss` / `ContentScope`** — reuse the existing sonner content wrappers
  verbatim (move `ClickToDismiss` into the new plugin; `ContentScope` stays imported
  from `@plugins/primitives/plugins/select-scope/web`).

## Guard against facet-a regression

Removing the loud throw means a future composition that omits the toast host loses
toasts **silently**. Net it with a test in
`plugins/plugin-meta/plugins/composition/core/config.test.ts`: assert the
`served-baseline` seed's `entryPoints` include `shell.toast` (and/or that
`resolveComposition` of an app composition bundles the toast host). This keeps the
"host must ship with any served app" invariant enforced without a runtime crash.

## Verification

1. `./equin build` — regenerates registries + docs + migrations (none), runs
   checks (`plugins-registry-in-sync`, `plugins-doc-in-sync`, `plugin-boundaries`,
   `composition-closure`, `type-check`). Must pass with the deleted/added plugins.
2. `./equin check type-check` — no dangling `ShellCommands` / `ImproveCommands`
   / `CommandPaletteCommands` / `defineCommand` references.
3. `bun test plugins/plugin-meta/plugins/composition/core/config.test.ts` — incl. the
   new served-baseline assertion.
4. `bun run test:dom plugins/improve` (if a button test exists) — improve popover
   still opens with seeded text.
5. Manual, at `http://<worktree>.localhost:9000`:
   - Trigger a toast (server restart on build → health's "Reconnected to server")
     and confirm it **renders** with **no** `No handler for command` console error.
   - `Cmd+K` opens the palette; element-picker + draw-on-app open the Improve
     popover seeded with text.
   - Run a **sonata release** and confirm the release console is clean (the original
     symptom is gone).
