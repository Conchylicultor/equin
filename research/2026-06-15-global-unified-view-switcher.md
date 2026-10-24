# Unified, config-driven view switcher

> Status: **roadmap / meta-plan**. This document defines the target architecture and an ordered sub-task breakdown. Each sub-task (ST*) is designed and implemented in its own pass; this doc is the contract they share.

## Context

The app has **two unrelated "view switcher" implementations** that look and behave differently:

1. **`defineTabbedView`** (`plugins/primitives/plugins/tabbed-view/`) — a slot factory where each view is an opaque `component`. Consumers: conversations (Queue / Grouped / History) and tasks (Tree / Recent). Its tab strip is hand-rolled markup — a bordered `rounded-md border bg-background` **track box** with `flex-1` buttons, carrying an `eslint-disable` that admits it "differs from SegmentedControl." This box is the heavy background the user dislikes.
2. **`data-view`** (`plugins/primitives/plugins/data-view/`) — a generic surface: a typed `FieldDef[]` schema rendered through view-type slot contributions (gallery / table / tree) with per-view sort/search/filter. Its switcher already uses the clean, borderless `SegmentedControl variant="ghost"` (the Notion-like look the user approves of).

Two problems follow: (a) the chrome is inconsistent (one boxed, one clean), and (b) neither supports **named view instances** — Notion's "Todo / Coming / Done / Goals" are multiple *saved instances of the same view-type*, each with its own sort/filter. Today there is exactly one instance per registered type, hard-wired in code via a `views={["gallery","table"]}` whitelist.

**Intended outcome:** one shared switcher chrome everywhere, plus a config-driven *named-instance* model so users and agents can add, rename, duplicate, reorder, and customize views by editing config files (`views: [{…}, {…}]`) — exactly as the `reorder` primitive already makes slot order/visibility config-driven.

### Confirmed product decisions (fixed requirements)

1. **Bespoke views stay on a separate primitive.** Conversations' Queue and Grouped are irreducibly bespoke (fractional-rank DnD queue, server-persisted groups, fork nesting); they are *not* folded into the generic model. Only genuinely-generic views get named instances.
2. **Full Notion-style named instances.** Config declares N named instances, each referencing a view-type + its own saved sort/filter/group; add / rename / duplicate / reorder / delete.
3. **Per-app scope.** One view list per consumer, with config_v2's existing global-default → per-app-override layering (`scopeId: "app:<id>"`).
4. **Shared switcher chrome both consume.** The *chrome* (SegmentedControl) is universal so bespoke and generic views look identical; the *named-instance config model* is used only by the generic side. `tabbed-view`'s generic slot-factory role is absorbed; it survives (if at all) only as a thin opaque-component host for the bespoke views.

## Target architecture

Three seams, layered. ST1 is shippable on its own and resolves the user's original complaint.

### Layer 1 — `view-switcher` chrome primitive (presentational)

A new `plugins/primitives/plugins/view-switcher/` exposing `<ViewSwitcher options={[{id,title,icon}]} activeId onSelect />`, built on `SegmentedControl variant="ghost"` (borderless, Notion look). Both hosts render their switcher through it:
- `data-view/web/components/view-switcher.tsx` → repoint onto it (near-identical today).
- `tabbed-view`'s hand-rolled strip (`define-tabbed-view.tsx:65-89`) → replace with it, dropping the eslint-disable.

Conversations and tasks pick up the clean chrome immediately. No config, no data-model change.

### Layer 2a — view-type registry generalization

Normalize data-view's `DataViewSlots.View` contribution into the shared vocabulary `{ type, title, icon, order, hierarchical?, configSchema?, component }` (`configSchema` declared but unused in this layer). Keep **today's behavior** via a **default-instances-from-registered-types** resolver: synthesize one instance per resolved type id, `views={[…]}` still authoritative. Pure refactor, lives inside data-view. De-risks 2b by separating "registry shape" from "named instances."

### Layer 2b — config-driven named-instance model

The genuinely new piece. A per-consumer `views` config (one `listField` descriptor keyed by the consumer's `storageKey`) declaring instances; a resolver hook turns config → ordered instances → active instance → rendered view-type component seeded with the instance's saved sort/filter/group, switcher via Layer 1.

**Instance row shape (polymorphic, mirrors the reorder node-type registry):**
```jsonc
// @hash <12-hex>
{ "views": [
  { "id": "<uuid>", "rank": "a0", "name": "Todo",  "type": "table",   "options": { "sort": {...}, "filters": {...}, "visibleColumns": [...] } },
  { "id": "<uuid>", "rank": "a1", "name": "Board", "type": "gallery", "options": { "coverField": "icon" } }
] }
```
- The `listField` item's auto-injected `id` **is** the view-instance identity (localStorage active-id points at it; switcher selects it). Do **not** mint a separate id.
- `rank` (fractional index) drives switcher order → drag-reorder for free via the list field renderer.
- `type` references a registry id (renaming a registered view-type orphans instances — document, same hazard as reorder ids).
- `options` is a **type-dispatched sub-form**: validated/rendered by the chosen view-type's `configSchema` (a config_v2 `FieldsRecord`), dispatched by `type` exactly like reorder dispatches `{type,...payload}` to a registered node-type schema. This needs a new **type-dispatched object field** under `fields/` — the riskiest new machinery.

**State persistence split:**

| State | Lives in | Rationale |
|---|---|---|
| Instance def: `{id, rank, name, type, options{sort,filters,group,…}}` | **config_v2 row** | Nameable, shareable, agent-editable, git-committable, scope-layered — this *is* the instance |
| Active instance id | **localStorage** `${storageKey}:active-view` (reuse existing) | Ephemeral per-device selection |
| Transient search query | **localStorage / component state** | A saved query is noise in a shared view |
| Tree expand map | **localStorage** `expanded` (reuse) | Already local; server expand stays on `HierarchyConfig` |

So today's `ViewState.sort/filters` migrate from localStorage into the config row; `query`/`expanded`/active-id stay local. The config row seeds the view's initial sort/filter. **v1 simplification:** write-through to config on every sort/filter change with an optimistic local overlay + debounced persist (avoids building a Notion-style "unsaved changes / save view" UI). Flag explicit-save as a later enhancement.

### Where Layer 2 lives

Keep 2a **inside data-view** (generalize in place — avoids churning the doc/check surface for no behavioral gain). Design 2b's resolver **data-view-agnostic from day one** (knows only "view-type component + opaque per-instance config", never `FieldDef`/rows), physically inside data-view. **Revised decision (ST6, 2026-06-18):** rather than a standalone top-level `plugins/primitives/plugins/views/`, extract the type-agnostic engine into the **child sub-plugin `plugins/primitives/plugins/data-view/plugins/view-core/`**, with `data-view` as the **consumer** (parent imports child). This is done regardless of a second consumer — it's a clean internal seam (engine vs. render-contract), not a shared-primitive promotion. The engine stays inside the data-view umbrella where it's discoverable, while still drawing the clean seam so a future *direct* `view-core` consumer can depend on it. The child must never import `data-view/{core,web,server}` (a review-only no-cycle invariant — see `view-core/CLAUDE.md`). This honors "shared primitive both consume" at the *seam* level immediately while keeping the engine where it belongs.

### Backward-compat

`views={[…]}` is a whitelist of *type ids*, not instances. When **no config row exists**, synthesize default instances from the resolved type list (today's exact behavior — the analogue of reorder's "unlisted live contributions append in natural order"). When a **config row exists**, it is authoritative for instance set/order/state, and `views={[…]}` degrades to a capability gate (which types this consumer may instantiate — keeps `tree` out of non-hierarchical sources). `storageKey` is retained as both the descriptor key seed and the localStorage namespace → **zero breaking changes** to the 4 existing `<DataView>` call sites. 3 of 4 are single-view and never see a switcher until someone adds a second instance — graceful, opt-in.

## Sub-task roadmap

| ST | Scope | Deps | Tier |
|---|---|---|---|
| **ST1** | **Chrome unification.** Extract `view-switcher` primitive; repoint `data-view/web/components/view-switcher.tsx` and replace `define-tabbed-view.tsx:65-89` strip. Resolves the original complaint; conversations+tasks get the Notion look. | — | Core, shippable alone, lowest risk |
| **ST2** | **View-type registry generalization (2a).** Normalize `DataViewSlots.View` to `{type,title,icon,order,hierarchical?,configSchema?,component}`; add default-instances resolver; behavior unchanged. | ST1 | Core |
| **ST3** ⚠️ | **`views` config descriptor + polymorphic instance row (2b-storage).** Per-`storageKey` `listField` descriptor (copy reorder's descriptor-singleton + web/server `ConfigV2.Register`/`WebRegister` + build-time manifest). New type-dispatched `options` field under `fields/`. **Riskiest.** | ST2 | Core |
| **ST4** | **Named-instance resolver + state split (2b-resolver).** config → instances → active → seed sort/filter/group → render → debounced write-back. Switcher add/rename/duplicate/delete/reorder actions. Demote `use-view-state.ts` to ephemeral-only. | ST3 | Core |
| **ST5** | **Consumer migration + default fallback verification.** Confirm all default-fallback call sites unchanged (there are **9** `<DataView>` consumers, not 4 — see note); fix config-mode option composition (code-supplied `viewOptions` were dropped); author a committed reference instance set for `sonata/library` (only config-mode/multi-view consumer). Build-time manifest **deferred to ST6**. See [`2026-06-18-global-st5-dataview-consumer-migration.md`](./2026-06-18-global-st5-dataview-consumer-migration.md). | ST4 | Core |
| **ST6** | **Extract `data-view/plugins/view-core/`.** Move the type-agnostic instance engine + config-descriptor machinery into a data-view child sub-plugin; data-view becomes a consumer. (Done 2026-06-18 — see [`2026-06-18-global-st6-view-core-extraction.md`](./2026-06-18-global-st6-view-core-extraction.md).) | ST5 | Optional / structural |
| **ST7** | **Migrate tasks Tree/Recent to named instances.** View config over `tasksResource`; retain `Tasks.TaskActions`/`ListActions` as view-type-scoped slots; retire tasks' `defineTabbedView`. Tasks consume `view-core` **via data-view** — no change to the consumer model (tasks still use `<DataView>`); a future *direct* `view-core` consumer remains possible but is not required by ST6. | ST6 | Optional / later |
| **ST8** | **Slim/retire `tabbed-view` for bespoke views.** Conversations' Queue/Grouped/History stay opaque; host becomes "active component + ST1 switcher". Decide tabbed-view survives vs thin `bespoke-view-host`. | ST1 | Optional / later |

> **ST5 reconciliation (2026-06-18).** This doc's "4 consumers" framing is stale — there are **9** `<DataView>` call sites: `sonata/library` (the only config-mode/multi-view one — `views={["gallery","table"]}`), plus 8 single-view default-fallback consumers (`deploy/servers`, `story/shell`, `conversations/agents`, `pages/page-tree`, `tasks/task-list/tree`, `config_v2/settings`, `ui/tweakcn/community-browser`, `home/app-cards`). The principle holds: only `sonata/library` registers a `viewsDescriptor` and carries a `views.origin.jsonc`; the other 8 rely on the default-instances fallback with no committed config. The build-time manifest from gotcha #99 (auto-registering every consumer) is **deferred to ST6** under the opt-in model.

**Riskiest: ST3** — combines the most novel machinery (polymorphic type-dispatched config field) with the most fragile infra (config origin codegen, web↔server descriptor bridge, manifest sync). Everything downstream depends on its data model. De-risk by prototyping the instance-row schema + type-dispatched renderer against `sonata/library` alone before generalizing.

## Critical files

- Chrome: `plugins/primitives/plugins/data-view/web/components/view-switcher.tsx`, `plugins/primitives/plugins/tabbed-view/web/internal/define-tabbed-view.tsx`, `plugins/primitives/plugins/toggle-chip/web/internal/toggle-chip.tsx` (`SegmentedControl`).
- Registry/state: `plugins/primitives/plugins/data-view/web/slots.ts`, `.../web/components/data-view.tsx`, `.../web/internal/use-view-state.ts`, `.../core/internal/types.ts`.
- Config-driven pattern to copy: `plugins/reorder/web/internal/descriptors.ts`, `plugins/reorder/shared/reorderable-slots.generated.ts`, `plugins/reorder/{web,server}/internal/config-registrations.ts`, `plugins/reorder/plugins/node-types/` (type-dispatch precedent).
- Config + list machinery: `plugins/config_v2/{core,web,server}`, `plugins/fields/plugins/list/plugins/config/core/internal/list.ts`.

## Gotchas

- **Config origin codegen.** Descriptors must exist at build time for `./equin build` to emit `views.origin.jsonc`. A `<DataView storageKey="x">` consumer is invisible to the server — surface consumers via a **build-time manifest** (mirror `reorderable-slots.generated.ts`). No lazy first-render registration.
- **`// @hash` invariant.** `setConfig` throws if no origin was propagated. The resolver must fall back to default-instances when no descriptor/origin exists — never `setConfig` against an unregistered descriptor.
- **Reference-stable descriptor singletons.** `useConfig` matches descriptors by `===`. Build each per-`storageKey` descriptor once in one module imported by both the `WebRegister` site and the resolver (reorder's `descriptors.ts` map is the template).
- **Collection-consumer separation.** Consumers import only the generic registry + host — never `data-view/plugins/{gallery,table,tree}` by name. `views={[…]}` stays string ids only. New view-types remain zero-consumer-change child plugins. The type-dispatched config field belongs under `fields/`, respecting the type-dimension-owned-by-fields rule.
- **Docs/check sync.** New plugins and changed barrels regenerate the autogen reference block; `plugins-doc-in-sync` fails on drift. New manifest → add a `*-in-sync` check (model on `reorderable-slots-in-sync`). When a view-type's `configSchema` changes the origin hash under a committed instance set, `config-origins-in-sync` fails by design — budget for re-stamping `@hash`.
- **Write-back UX.** Config writes round-trip through server (set-field + watcher); per-click write-through feels laggy and spams the watcher. Mitigate with optimistic local overlay + debounced persist (decided in ST4).

## Verification (per sub-task)

- **ST1:** `./equin build`; Playwright screenshot conversations sidebar + a `sonata/library` DataView before/after — both switchers render identical borderless ghost chrome; the bordered box is gone. `./equin check` (eslint clean, no-adhoc-row not re-triggered).
- **ST2:** No visual/behavioral change; existing localStorage active-view + sort still work across gallery/table/tree; `type-check` + `plugins-doc-in-sync` pass.
- **ST3:** Hand-author a `config/.../views.jsonc` with two instances; `./equin build` regenerates origin; `query_db`/inspect confirms config load; the new type-dispatched field validates an `options` blob against the chosen type's schema; manifest sync check passes.
- **ST4:** In-app: add/rename/duplicate/reorder/delete an instance via the switcher → changes persist to the config file (verify on disk) and survive reload; sort/filter change on a named instance write-backs to its `options`; active-id stays local (different per browser).
- **ST5:** All 4 consumers load unchanged with no committed config (default fallback); `sonata/library`'s committed reference set renders its named instances; `config-origins-in-sync` green.
- **ST7:** tasks Tree/Recent reproduce current behavior as named instances; `TaskActions`/`ListActions` still render; conversations (bespoke) untouched.
