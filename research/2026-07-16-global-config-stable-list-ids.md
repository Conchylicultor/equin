# Stable, content-independent ids for identity-bearing config lists

## Context

A DataView "view instance" (e.g. Pages' **Favorites**) is a config row. A user's
**manual row order** for that view is stored in a separate DB table
(`data_view_row_order`) keyed on `(dataViewId, viewId, rowKey)` — because the
order is large, per-user runtime data that cannot live in the git-committed
config. So `viewId` is the **durable handle** linking a view to state stored
outside it.

Today that handle is **derived from the view's content**. When a `listField`
config row is authored without an explicit `id`, config_v2's
`injectCollectionIds` (`plugins/config_v2/server/internal/registry.ts:61-70`)
fabricates one on every read:

```ts
out.id = `auto-${computeHash([index, content])}`;   // content = the row minus id/rank
```

So renaming a view, editing its filter/sort/visibleFields, or **inserting a view
above it** (which shifts `index`) all mint a **new** `viewId` — and every
`data_view_row_order` row keyed on the old id is silently orphaned. The user's
hand-arranged order reverts to source order with no error.

### Why this bites hand-authored configs specifically

A UI rename is actually **safe**: the web already receives the injected id and
round-trips it back as an explicit `id` on the debounced `setConfig` write
(`use-views-config.ts` `renameView`/`applyMutation`), so once persisted the id is
stable. The hazard is **git-authored terse rows edited on disk** — the normal
agent authoring workflow — where the id is *never persisted* and re-derives from
`[index, content]` every read.

### Scope of the problem (from exploration)

- **Only `data_view_row_order` (view-order) keys durable DB state on `viewId`.**
  `custom-columns` deliberately omits `viewId`; the only other `viewId`-keyed
  state is device-local localStorage (query/expand, active-id) whose churn is
  harmless.
- **23 of 24 DataView configs author terse `{ name, view }` rows with no id.**
  `config/apps/pages/page-tree/pages-sidebar.jsonc` is the sole exception — it
  hand-authors explicit ids as a documented local workaround. Every other config
  is a latent orphan the moment a user arranges an order in one of its views.

### Decisions (locked with the user)

1. **A check requires explicit ids; build never mutates config files.** Build
   keeps only ever generating origins — hand-authored overrides stay
   hand-authored. The forcing function is a `./equin check` that fails when
   an identity-bearing list row lacks an explicit `id`.
2. **Bare slug ids**, unique within the surface (`"favorites"`, `"online"`). The
   surface is already implied by the file and by the DB key's `dataViewId`, so the
   id does **not** repeat it.
3. **The author writes the id by hand** (there is no auto-derived value to pick).

The identity of a list instance must not depend on its content — this makes that
structural, enforced repo-wide, and generic (any future durable-key list opts in,
not just views).

## Design

Introduce a generic, opt-in **"stable identity"** contract at the config_v2
`listField` layer, enforced by a new check. Runtime behavior is unchanged.

### 1. Opt-in flag on `listField`

`plugins/fields/plugins/list/plugins/config/core/internal/list.ts`

- Add `stableIdentity?: boolean` to `listField`'s `opts`.
- Add `readonly stableIdentity: boolean` to the `ListFieldDef` interface.
- Include `stableIdentity: opts.stableIdentity ?? false` in the frozen returned
  object (it must live on the `FieldDef`, not `meta`, so the check reads it off
  `descriptor.fields[key]`).

Semantics (documented on the flag): *the item ids of this list are used as
durable external keys, so each row must carry an explicit, content-independent
`id` persisted in the config file.* Lists **without** the flag (preprompts,
prompt-templates, sort/filter presets, reorder items, …) are unaffected — their
ids are render-only and the content-hash fallback is fine for them.

### 2. Set the flag on the views list

`plugins/primitives/plugins/data-view/plugins/view-core/shared/internal/views-descriptor.ts`

```ts
views: listField({
  label: "Views",
  stableIdentity: true,          // ← view ids key data_view_row_order
  itemFields: { name: textField(...), view: variantField(...) },
}),
```

This single edit covers **every** DataView surface (one `viewsDescriptor` per id,
all built from this factory). The `extraFields` presets lists stay unflagged.

### 3. New check: `config-stable-list-ids`

New sibling of the existing config check, mirroring its structure byte-for-byte:

- `plugins/framework/plugins/tooling/plugins/checks/plugins/config-stable-list-ids/check/index.ts`
- `.../config-stable-list-ids/package.json` (copy the `config-origins-in-sync`
  sibling's package.json)
- `.../config-stable-list-ids/CLAUDE.md`

`./equin build` auto-discovers `check/index.ts` and regenerates
`check.generated.ts` (like every other check sub-plugin — no manual registry
edit; `dependsOn: ["config_v2"]` falls out of the import).

**What it does** (reusing the exact plumbing of `config-origins-in-sync`):

1. `loadConfigDescriptorsByOriginPath({ root })` → map `<hier>/<name>.origin.jsonc`
   → `ConfigDescriptor` (from `@plugins/framework/plugins/tooling/plugins/codegen/core`).
2. Enumerate committed + untracked config files via
   `git ls-files --others --cached -- config/`, keep every `*.jsonc`.
3. Resolve each file → descriptor using the same anchor trick the sibling uses:
   `stripScopeSegment(path).replace(/\.jsonc$/, ".origin.jsonc")` (so a base
   override, a scoped `@app/<id>/` delta, and an origin all resolve to the base
   descriptor).
4. For each descriptor, collect field keys where
   `isListFieldDef(field) && field.stableIdentity`. Skip files whose descriptor
   has none.
5. Parse the file (`jsoncParse`, stripping the `// @hash` header) and for each
   such list key **present** in the document, assert every row has a non-empty
   **string** `id`, and that ids are **unique within that list**. (A file that
   omits the key — e.g. a partial scoped delta or the empty origin `{views:[]}`
   — trivially passes.)

**Failure message** names the file, the field, and the offending row (`name` if
present, else index), with a hint:

> `config/apps/deploy/servers/deploy.servers.jsonc`: view `"Online"` in list
> `views` has no explicit `"id"`. Identity-bearing list rows need a stable id so
> external state (e.g. saved row order) survives edits. Add a bare slug, e.g.
> `"id": "online"`.

Top-level lists only (views are top-level); nested stable-identity lists are out
of scope (YAGNI, documented).

### 4. Migrate the 23 terse configs

Add `"id": "<slugify(name)>"` to every view row in the terse configs so the new
check passes. Files (all under `config/`, from exploration):

`apps/deploy/servers/deploy.servers.jsonc`, `apps/home/app-cards/home.apps.jsonc`,
`apps/mail/inbox/mail-inbox.jsonc`, `apps/prototypes/gallery/prototypes.gallery.jsonc`,
`apps/sonata/library/sonata.library.jsonc`, `apps/story/shell/story.gallery.jsonc`,
`apps/studio/explorer/studio.explorer.tree.jsonc`,
`apps/workflows/definitions/workflows.definitions.jsonc`,
`apps/workflows/executions/workflows.executions.jsonc`,
`code-explorer/code-explorer.file-tree.jsonc`,
`config_v2/settings/config_v2.settings.nav.jsonc`,
`conversations/agents/agents-list.jsonc`,
`conversations/all-conversations/all-conversations.jsonc`,
`conversations/conversations-view/data-view/history/conversations-sidebar-history.jsonc`,
`conversations/conversations-view/data-view/queue/conversations-sidebar-queue.jsonc`,
`debug/profiling/runtime/debug.profiling.runtime.jsonc`,
`debug/reports/debug.reports.jsonc`,
`debug/slow-ops/cluster/debug.slow-ops.cluster-aggregate.jsonc`,
`debug/slow-ops/cluster/debug.slow-ops.cluster-timeline.jsonc`,
`debug/slow-ops/pane/debug.slow-ops.local.jsonc`,
`debug/trace/pane/debug.trace.events.jsonc`,
`tasks/task-list/tasks-list.jsonc`, `tasks/task-list/tasks-subtree.jsonc`,
`ui/tweakcn/community-browser/tweakcn.community-browser.jsonc`.

Rule: `id = slugify(name)`; disambiguate a within-file collision with a suffix.
Only the top-level view rows need ids — the `"id"` values already inside
filter groups / rules / presets are unrelated and stay. `pages-sidebar.jsonc`
already complies (no change; its now-redundant explanatory comment can be
trimmed to point at the check).

This is **hash-safe**: ids are added to the override body; the `// @hash` tracks
the (empty) origin and is unaffected. `config-origins-in-sync` still passes.

### 5. Runtime: unchanged

`injectCollectionIds` and `normalizeRows` stay exactly as-is. The content-hash
remains the read-time idempotency fallback for the pre-persist window and for
non-`stableIdentity` lists. Once a row carries an explicit `id`, both paths pass
it through verbatim — the whole pipeline is stable end-to-end. No migration code,
no view-core changes.

### 6. Docs

- Fix `plugins/fields/plugins/list/CLAUDE.md` and
  `plugins/fields/plugins/list/plugins/config/CLAUDE.md`, which inaccurately state
  the id is an "auto-injected (UUID)". Clarify: absent an explicit id, the
  registry seeds a **content+index hash** (idempotent but content-dependent);
  document `stableIdentity` and when to set it.
- Note the `stableIdentity` requirement + the check in
  `plugins/primitives/plugins/data-view/plugins/view-core/CLAUDE.md` (and a line
  in `view-order/CLAUDE.md`).

## Migration caveat (one-time)

Adding explicit slug ids to the 23 terse configs changes their runtime `viewId`
from the current `auto-<hash>` to the slug. Any `data_view_row_order` rows a user
already arranged in those views orphan **once** and revert to source order — the
same one-time cost `pages-sidebar` already paid when its workaround landed. This
is acceptable: row-order is a niche feature and these are largely fresh configs.
No automated data backfill.

## Critical files

- `plugins/config_v2/server/internal/registry.ts:43-75` — `injectCollectionIds`
  (the mechanism; **unchanged**, referenced for context).
- `plugins/fields/plugins/list/plugins/config/core/internal/list.ts` — add the
  `stableIdentity` flag.
- `plugins/primitives/plugins/data-view/plugins/view-core/shared/internal/views-descriptor.ts`
  — set `stableIdentity: true`.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/config-origins-in-sync/check/index.ts`
  — the template to mirror (`stripScopeSegment`, `git ls-files`,
  `loadConfigDescriptorsByOriginPath`, `Check`/`CheckResult` shape).
- `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts`
  — exports `loadConfigDescriptorsByOriginPath` the check reuses.
- The 23 config `.jsonc` files listed above.

## Verification

1. **Check fails before migration.** After adding the flag + check and running
   `./equin build`: `./equin check config-stable-list-ids` fails,
   listing the terse configs. Confirms the flag propagates through
   `discoverConfigs` → `descriptor.fields.views.stableIdentity` and the file→
   descriptor resolution works.
2. **Check passes after migration.** Add the slug ids →
   `./equin check config-stable-list-ids` passes; `./equin check`
   (all, incl. `config-origins-in-sync`, `type-check`) stays green.
3. **Negative test.** Delete an `id` from one config → check fails with the
   pointed message; restore → passes. (Optionally pin as a `bun:test` beside the
   check with a temp fixture dir.)
4. **End-to-end identity stability.** In the running app (`./equin build`,
   `http://<worktree>.localhost:9000`): open a DataView with an explicit-id view,
   drag rows into a manual order, then **edit that view's filter/name directly in
   its `.jsonc`** and rebuild. The saved order **survives** (viewId unchanged) —
   the exact scenario that silently reverted before. Drive with
   `e2e/screenshot.mjs` (arrange → edit file → reload → assert order).
