# Live values: `liveValue` / `serveValue`, one `preload` field (proof: the bell's unread badge)

## Context

The unified live-resource API (`plugins/network/plugins/live`) covers collections only
(`liveCollection` / `serveCollection` / `useLive` / `useLiveRow`). About 80 of the ~113
declarations are **values** (`resourceDescriptor` + `defineResource` /
`defineExternalResource`), and they still use the old spellings, with four problems
(Resources page, sub-page "Live resources — audit and target model" §4–6, §8 F / A):

- **The `mode` default is the rare value.** `contractToDefinition` (`resource-runtime/core/runtime.ts:641`) and
  `createResource` (`:2104`) default to `"invalidate"`. 82 sites write `"push"` and 7 write `"invalidate"`.
- **`notify()` comes from a separate server factory** (`defineExternalResource`).
- **Two unrelated flags for one concept:** `bootCritical` (the server-side boot snapshot, the L2 persist
  and the eager tier) and `resident` (the client's `gcTime: Infinity`).
- **Nothing stops a Postgres-backed array value from growing without bound.**

This is phase 2 of `research/2026-09-25-global-unified-live-resource-api.md` ("Phases after
the proof"). The bulk migration (phase 3) cannot start until values exist.

**Proof target.** The bell's unread badge (`shell/notifications/web/components/bell-button.tsx`)
counts `!read && !muted && variant ∈ {error, warning}` over the default window only (the newest
200 undismissed rows), so it undercounts once there are more. It must be exact across the whole
table and preloaded at boot, with no loading flash. The previous proof recorded this as "a count
of unread is a value (phase 2)" (`research/2026-09-25-global-live-bell-filter-groupby-preload.md` §3).

**Decision (user, 2026-09-25): one field now, config last.**
- The descriptor, `Resource.Declare` and every runtime reader read only `preload`.
- The 13 old `bootCritical: true` sites become `preload: "boot"` in this change.
- Config's two `resident: true` resources are the one legacy flag left. Config hydrates N param
  tuples per page through its own boot task, and the boot snapshot hydrates only one default
  tuple, so config cannot honestly be `"boot-and-keep"` yet. Page item 9 ("delete config's own
  boot hydration") owns the deletion of `resident`.

## Design principles held

- **Declare a value, never a delivery mode.** Push is what a value is. Loading on demand is an
  explicit, named opt-in for an expensive loader.
- **No new read hook.** `useLive(value)` returns `ResourceResult<T>` (pending | data), the same
  states as today's `useResource`. §9 of the sub-page already spells it `useLive(sentinelStatus)`.
  A value's result has no *new* states, so it gets no new hook (the `groupBy` rule).
- **Not known yet is a state.** `liveValue` has no `initial`. Today `initialData` is only a
  typed placeholder, seeded at `dataUpdatedAt: 0` so it always reads `pending`
  (`use-resource.ts:274`). Its one real reader is `useOptimisticResource`'s pending base
  (`use-optimistic-resource.ts:181`).
- **The rule is a type, not a check.** A `source: "db"` value whose type is an array, or a
  string-indexed record, must carry `unbounded: { reason }`. The `source` arm is what lets a small
  in-memory array stay legitimate without a check (it answers the sub-page's "stays a check" note).

## 1. Declare — `liveValue` (`network/live/core`)

```ts
export const notificationsUnread = liveValue("notifications.unread", {
  schema: NotificationsUnreadSchema,         // z.object({ errors, warnings })
  preload: "boot",                           // "none" (default) | "boot" | "boot-and-keep"
});

export const taskDetail = liveValue("task-detail", {
  schema: TaskDetailSchema,
  params: ["id"],                            // → P = { id: string }; preload is `never` here
});
```

- **The key** is a positional string literal (the build scanners read it), like `liveCollection`.
- **`params`** is optional, a `const` tuple of names, and derives `P = Record<name, string>`.
  - It replaces the old phantom `P` generic, which callers had to restate.
  - `preload` is typed `never` when `params` is present. A preloaded value needs a default
    tuple the server can load before a tab names one, and only a param-less value has one. This is
    the rule the codebase already follows: every `bootCritical` plain descriptor is param-less.
- **What it returns:** a `LiveValue<T, P>`, which is a `ResourceDescriptor<T, P>` with
  `live: "value"`, `params`, `preload`, and no `initialData`.
  - When preloaded, it also sets `defaultParams: {}`, so the boot snapshot's fallback loader
    (`handle-boot-snapshot.ts:41`) and the client's hydrate (`boot-snapshot/web/internal/boot.ts:53`) hit the
    same tuple that `useLive(v)` subscribes to.
- **`ResourceDescriptor.initialData` becomes optional.**
  - `useResource` passes it through as is: `undefined` means no placeholder, and the result is
    still `pending` while `dataUpdatedAt === 0`.
  - `useOptimisticResource` narrows its parameter to a descriptor *with* `initialData`. Passing a
    `liveValue` there is a tsc error until phase 3 decides how optimistic values get their base.
- **`LivePreload` becomes `"none" | "boot" | "boot-and-keep"`**, one type shared by both
  declarations. A collection's `"boot-and-keep"` also applies to its window only.

## 2. Serve — `serveValue` (`network/live/server`)

```ts
export const notificationsUnreadServed = serveValue(notificationsUnread, {
  source: "db",
  loader: countUnread,
});
// contributions: [...notificationsUnreadServed.declare]

export const sentinelServed = serveValue(sentinelStatus, {
  source: "external",
  loader: readStatus,
});
sentinelServed.notify();                     // only the external arm has notify(params?)
```

**Options:**

- `source: "db" | "external"` (required).
  - `"db"`: `createResource(def, externalSource=false)`. The read-set is captured at the pool
    chokepoint, and a table change is a full recompute of every subscribed tuple, with no scope
    policy. This is the same path `:groups` already uses.
  - `"external"`: `externalSource=true`, which returns `notify`.
- `loader: (params: P) => Promise<T> | T`.
- `load?: "push" | "on-demand"`, default `"push"`. `"on-demand"` maps to the runtime's
  `"invalidate"`: the server skips the loader in the flush and each tab refetches over HTTP. It is
  for slow loaders kept out of the shared flush cycle (sub-page §5).
- `unbounded: { reason: string }`: **required** by the type when `source: "db"` and `T` is an
  array or a string-indexed record, and `never` otherwise:
  ```ts
  type CollectionShaped<T> = T extends readonly unknown[] ? true : string extends keyof T ? true : false;
  type BoundArm<Src, T> = Src extends "db" ? (CollectionShaped<T> extends true
    ? { unbounded: { reason: string } } : { unbounded?: never }) : { unbounded?: never };
  ```
  The reason is recorded on the served resource, so the docs facet can list it.
- **Deliberately not in this phase:** `debounceMs`, `dependsOn`, `revalidate`, `ackChannel`. Each
  one arrives with the first phase-3 call site that needs it, carrying that site's reason. Scope
  policies stay collection-only: a keyed payload is a collection.

**Returns** `ServedValue<T, P>`: the runtime `Resource<T, P>`, plus `declare` as a 1-tuple, so
every served thing is spread the same way (`...x.declare`). The external arm adds `notify`.

**The runtime default.** The old `defineResource`'s `?? "invalidate"` stays as it is. The old
factories are deleted as phase 3 migrates their call sites (the no-wrapper decision), and
`serveValue` never reaches that default.

## 3. One `preload` field — retire `bootCritical` (`resident` goes last)

| Reader | Today | After |
|---|---|---|
| `ResourceDescriptor` (`live-state/core/resource.ts`) | `bootCritical?: true`, `resident?: true` | `preload?: "boot" \| "boot-and-keep"`. `resident?: true` stays, commented "config only, deleted by item 9" |
| Old factories' opts (`resourceDescriptor`, `keyedResourceDescriptor`, `centralResourceDescriptor`, `query…`, `windowQuery…`, `pointQuery…`) | `{ bootCritical?, resident? }` | `{ preload?, resident? }` |
| Server `ResourceDefinition` / `Resource` (`resource-runtime/core/runtime.ts`), including the rowIdentity-vs-boot guard | `bootCritical` | `preload` |
| `Resource.Declare` payload (`server-core/core/resources.ts`) | `bootCritical?: boolean` | `preload?: …` |
| Boot snapshot keys (`boot-snapshot/server/internal/boot-keys.ts`), L2 `shouldPersist` (`live-state-snapshot/server/internal/persist.ts`, `boot-init.ts`) | `c.bootCritical` | `c.preload !== undefined` |
| Client `gcTime` (`live-state/web/use-resource.ts:285`) | `resource.resident` | `resource.preload === "boot-and-keep" \|\| resource.resident` |
| `liveCollection` (`live-collection.ts:178`) | translates `"boot"` into `{ bootCritical: true }` | forwards `preload` as is |
| Vocabulary `PreloadFlag` (`resource-vocabulary/core/vocabulary.ts:90`) | `{field:"bootCritical"} \| {field:"preload",value:"boot"}` | one spelling, `{ field: "preload" }`, where `"boot"` and `"boot-and-keep"` both preload |
| Eager tier (`codegen/core/eager-tier-gen.ts` `preloadsBoot`) | two spellings | one spelling. Still throws on a non-literal value |

- **The 13 call sites** (mechanical: `bootCritical: true` becomes `preload: "boot"`):
  - `build.deployment`, `build.history`, `task-categories`, `release.previews`, `worktree-ops`,
    `agents`, `agent-launches`;
  - in `tasks-core/core/resources.ts`: `tasks`, `attempts`, `conversations-active`,
    `conversations-system`, `conversations-gone`, `conversations-gone-stats`.

  They stay on their old factories; phase 3 moves them.
- **Stale docs fixed:** `infra/boot-snapshot/CLAUDE.md` (it still says `Resource.Declare(r, { bootCritical: true })`),
  `live-state/CLAUDE.md` (the flags section) and `network/live/CLAUDE.md`.
- After this change, `rg "bootCritical" plugins` matches only comments and history notes, and
  `resident` appears only in `config_v2`.

## 4. Read — `useLive(value, params?)` (`network/live/web`)

- **A new overload, discriminated on the declaration.** A `LiveValue` has `live: "value"`, and a
  collection has `window`.
  - It is `useLive(v)` when `P` has no keys, and `useLive(v, params)` otherwise (params required).
  - The result is `ResourceResult<T>`.
  - It delegates to `useResource`. The canonical tuple is the params object, which is already
    string-valued.
- **No `select` option yet.** Today 10 sites use it. It arrives when phase 3 migrates the first
  of them.
- **`live-state/no-pending-data-collapse`** already watches `useLive`. Add a jsdom case so a
  value read is covered too.

## 5. Scanners and checks

- **Vocabulary.**
  - New entry `liveValue: { barrel: LIVE_CORE, preload: { field: "preload" }, mints: [{ suffix: "", keyed: false, membership: null, preloadable: true }] }`.
  - New register marker `serveValue: { barrel: LIVE_SERVER }`.
- **`MintedDescriptor` drops `initialData`.** It matches on `key` + `schema`; otherwise
  `liveValue` (which has no `initialData`) would slip past the type-derived completeness filter.
  Over-inclusion is the safe direction, as that file's comment says.
- **The server-marker completeness asserts** in `resource-vocabulary/check/index.ts` must see
  `serveValue`'s return type as a served shape.
- **Docs facet** (`plugin-meta/facets/plugins/resources/facet/parse-resources.ts`): it reads
  `serveValue` as a register call, with mode `push`, or `invalidate` when `load: "on-demand"` is
  written literally. The mode is non-keyed, and it records `source` and `unbounded.reason`.
- **`keyed-resource-scope`:** unaffected. It scans `defineResource` only.

## 6. The proof — the bell's unread badge (`shell/notifications`)

- **One predicate, in the filter language.** Today the predicate exists in three copies: the
  bell, `notifications-panel.tsx:163` and the new loader. It becomes one declaration:
  ```ts
  // shared/unread.ts
  export const countedUnreadFilterable = { read: liveBoolean(), muted: liveBoolean(),
    variant: liveText(NotificationVariantSchema) };
  export const countedUnread = and(
    { column: "read", op: "eq", operand: false },
    { column: "muted", op: "eq", operand: false },
    { column: "variant", op: "in", operand: ["error", "warning"] });
  ```
  - The panel's `isCountedUnread` becomes `matchesFilter(n, countedUnread, countedUnreadFilterable)`.
  - The loader's WHERE is `filterSql(countedUnread, { read: sql\`${t.read}\`, … }, countedUnreadFilterable)`.
  - Both sides share the one op table, which the parity suite already pins against Postgres.
- **Declare** (`shared/resources.ts`):
  `notificationsUnread = liveValue("notifications.unread", { schema: z.object({ errors: z.number().int().nonnegative(), warnings: z.number().int().nonnegative() }), preload: "boot" })`.
  - The value is an object, not an array, so it needs no `unbounded` arm.
  - It is split by variant, because the badge's colour depends on whether any error is present.
- **Serve** (`server/internal/resources.ts`):
  `serveValue(notificationsUnread, { source: "db", loader })`. The loader runs
  `SELECT count(*) FILTER (WHERE variant='error') AS errors, count(*) FILTER (WHERE variant='warning') AS warnings FROM notifications WHERE NOT dismissed AND <countedUnread>`.
  - `dismissed = false` is the same base membership the collection uses.
  - Spread `.declare` into `server/index.ts`'s contributions.
- **Index.** Add a partial index `notifications_unread_badge_idx ON (variant) WHERE dismissed = false AND read = false AND muted = false`
  in `tables.ts`. The count is re-run on every write to the table, and today only `(dismissed)`
  is indexed. `./equin build` generates the migration.
- **Read-set guard.** `reconcile-read-set.ts` keeps
  `[...notificationsServed.keys, ...notificationsUnreadServed.declare.map(d => d.key)]`, with a
  plain `keys` field added to `ServedValue` for symmetry with `ServedCollection`. Without it, boot
  would evict the new reader's `notifications` edge.
- **L2.** A preloaded, db-backed, unbounded-by-membership value is persisted on every change.
  That is tens of bytes here, not the 200-row array that made the ~2 GB/day churn (sub-page §6).
- **Bell** (`bell-button.tsx`):
  - The badge reads `useLive(notificationsUnread)`. It is pending until settled, and then shows
    the neutral bell, as today.
  - The count is `errors + warnings`, and the colour is red when `errors > 0`.
  - `useLive(notifications)` stays for the toasts and the panel's `empty`.
  - The `IconButton` label carries the exact count ("Notifications, 250 unread"), because the
    visible badge caps at "9+". This makes the count testable and helps screen readers.

## Critical files

- `plugins/network/plugins/live/core/internal/{live-value.ts (new), live-collection.ts}`, `core/index.ts`
- `plugins/network/plugins/live/server/internal/serve-value.ts` (new), `server/index.ts`
- `plugins/network/plugins/live/web/internal/use-live.ts`, `web/index.ts`
- `plugins/primitives/plugins/live-state/{core/resource.ts, web/use-resource.ts}`, `plugins/primitives/plugins/optimistic-mutation/web/internal/use-optimistic-resource.ts`
- `plugins/framework/plugins/resource-runtime/core/runtime.ts`, `plugins/framework/plugins/server-core/core/resources.ts` (+ central-core facade)
- `plugins/infra/plugins/boot-snapshot/server/internal/boot-keys.ts`, `plugins/database/plugins/live-state-snapshot/server/internal/{persist.ts,boot-init.ts}`
- `plugins/framework/plugins/tooling/plugins/resource-vocabulary/{core/vocabulary.ts,check/index.ts}`, `…/codegen/core/eager-tier-gen.ts`, `plugins/plugin-meta/plugins/facets/plugins/resources/facet/parse-resources.ts`
- The 13 `bootCritical` sites listed in §3
- `plugins/shell/plugins/notifications/{shared/resources.ts, shared/unread.ts (new), server/internal/{resources.ts,tables.ts,reconcile-read-set.ts}, server/index.ts, web/components/{bell-button.tsx,notifications-panel.tsx}}`

## Verification

- **Tests:** `./equin test plugins/network/plugins/live plugins/primitives/plugins/live-state plugins/framework/plugins/resource-runtime plugins/infra/plugins/boot-snapshot plugins/database/plugins/live-state-snapshot plugins/framework/plugins/tooling plugins/plugin-meta/plugins/facets/plugins/resources plugins/shell/plugins/notifications`
  - `liveValue`:
    - `defaultParams: {}` only when preloaded;
    - `@ts-expect-error` cases: `preload` together with `params`; `useLive(v)` without its
      required params; a `liveValue` passed to `useOptimisticResource`.
  - `serveValue`:
    - the default mode is `push`, and `"on-demand"` maps to `invalidate`;
    - only the external arm has `notify`, and calling it pushes;
    - `@ts-expect-error` cases: a db array without `unbounded`, and `unbounded` on a non-array;
    - the `declare` payload carries `preload`.
  - Runtime readers:
    - the boot-keys and persist suites switched to `preload`;
    - a preloaded value is persisted, and a bounded window is not (unchanged).
  - Scanner fixtures:
    - `eager-tier-gen.test.ts` and `parse-resources.test.ts` gain a `liveValue` case with
      `preload: "boot"`;
    - an old factory with `preload: "boot"` is still marked;
    - a non-literal `preload` throws.
  - jsdom `use-live.test.tsx`:
    - `useLive(value)` goes from pending to settled;
    - a hydrated value is settled on its first render;
    - `"boot-and-keep"` survives past gcTime after unmount.
  - The notifications loader against `createTestDb`:
    - seed 260 undismissed rows (unread errors and warnings older than the newest 200, plus
      info, muted, read and dismissed rows);
    - the exact counts come back;
    - dismissing one row or marking all read moves the counts.
  - The panel suite still passes with `isCountedUnread` on `matchesFilter`.
- **`./equin check`:** type-check, `eager-tier-in-sync` (tasks-core and the others keep
  their pins; notifications is pinned by both keys), `resource-vocabulary`, `plugins-doc-in-sync`
  (`notifications.unread` is listed), `migrations-in-sync`.
- **`./equin build`**, then extend `shell/notifications/e2e/bell-filter.ts`:
  - seed 250 unread warnings plus 3 unread errors, all older than 200 fresh info rows;
  - the boot snapshot contains `notifications.unread = { errors: 3, warnings: 250 }`;
  - with websockets blocked, the bell still paints a red badge whose label reads 253, with no
    pending frame;
  - marking all read (open and close the popover) clears the badge live;
  - clean up through dismiss-all.
- **Slow-ops:** `get_runtime_profile` shows `loader` spans for `notifications.unread` with a small
  max. `get_timeline` shows no new flush stall.
- **Docs:**
  - `network/live/CLAUDE.md` gains a Values section;
  - `research/2026-09-25-global-unified-live-resource-api.md` marks phase 2 done and links here;
  - a status line in the Resources page's agent card (`block-f6465fff-…`) records values as done
    and the `resident` → item 9 ownership.

## Result (2026-09-25)

Shipped as designed: `liveValue` / `serveValue` / `useLive(value)`, `preload` replacing
`bootCritical`, and the bell's whole-table unread badge `notifications.unread` as the proof.

### Deviations

- **Part 1 (the API):**
  - The runtime readers' `bootCriticalKeys`-style names were renamed to `preloadedKeys`.
  - `useResource` disables its query while a descriptor has no `initialData` and nothing has
    landed, so a `liveValue` makes no HTTP fetch on mount — the WS sub-ack fills it
    (`refetch()` still works).
  - The resource vocabulary's preload flag is `PreloadFlag = { field, preloads, none }` (the field
    a factory spells preload with, the values that preload, and the one that does not).
  - The old factories' return types now spell `initialData` explicitly, so the `liveValue`
    descriptor (no `initialData`) is a distinct type that `useOptimisticResource` rejects.
  - One leftover `bootCritical` comment remains in
    `plugins/primitives/plugins/usage-rank/web/internal/use-usage-order.ts:16`: editing it trips a
    format-sensitive `eslint-disable` on the next line.
- **Part 2 (the proof):**
  - The payload schema is a named `NotificationsUnreadSchema` in `shared/schema.ts`.
  - The loader is `countUnreadNotifications(conn = db)` (db-parametrized for the DB suite), read
    through `sql-rows`' `executeOne`, which throws unless exactly one row comes back — a missing
    aggregate row can never read as "no unread". The counts are cast `::int`.
  - `reconcile-read-set.ts` uses `[...notificationsServed.keys, ...notificationsUnreadServed.keys]`
    (part 1 added `keys` to `ServedValue`).
  - The bell renders the neutral bell while EITHER read is pending: the window still feeds the
    toasts and the panel's `empty`. Both are preloaded, so neither is pending on the first frame.
  - The e2e bell locator is now `/^Notifications(, \d+ unread)?$/`. The unread check is a new
    step 5 after the existing ones, with its own dismiss-all. It asserts DELTAS over a baseline
    read from the boot snapshot right after that dismiss-all; the baseline was
    `{ errors: 0, warnings: 0 }`. "No pending frame" is asserted with an init-script
    `MutationObserver` that records every `aria-label` the bell ever had from the document's
    start: the list must be exactly `["Notifications, 253 unread"]`.
  - `./equin build` needed `--migration-name notifications_unread_badge_idx` for the new
    partial index (migration `20260925_190550_ba1ccdcd__notifications_unread_badge_idx.sql`).

### Verification results

- `./equin test plugins/shell/plugins/notifications plugins/network/plugins/live`: bun
  123 pass / 0 fail across 9 files (including the new `count-unread.test.ts`: 260 undismissed rows
  with counted errors/warnings behind 200 info rows → `{3, 5}`; SQL agrees with
  `matchesFilter` row for row; dismissing one → `{2, 5}`; mark-all-read → `{0, 0}`). Vitest 25
  pass across 3 files (`use-live`, the panel suite, and the new `bell-button.test.tsx`: pending
  → neutral bell; `{3, 250}` → label "Notifications, 253 unread", `9+`, red; warnings only →
  orange; zero → no badge). The bell suite logs Base UI's `nativeButton` warning, which is
  already present: `InlinePopover`'s trigger is a `<span>`.
- `./equin build`: checks passed (type-check included), deployed.
- `e2e/bell-filter.ts`: ALL CHECKS PASSED (24). These include the boot snapshot's
  `notifications.unread` being baseline + `{3, 250}` while the preloaded window holds only the
  200 info rows. With websockets blocked, every bell frame read "Notifications, 253 unread", and
  the badge was `9+` in red. Opening and closing the popover cleared the badge live
  (label → "Notifications").
- Slow-ops (`get_runtime_profile`, worktree backend right after the e2e):
  - `loader` `notifications.unread` ran 603 times (601 push, 2 sub), avg ~1 ms, max 14.4 ms.
  - The flush max was 314 ms, inside the e2e's seeding burst (≈700 sequential POSTs, parent
    `change-feed:connect`), plus a 443 ms flush at boot (+1.7 s). No flush has a value loader
    anywhere near that: the value's loader max is 14 ms.
  - `get_timeline` (20 min) shows no flush-stall event. Its warnings are unrelated
    (`midi-folders:reconcile`, `page-load /home` on a loaded host).
  - A `live-state-noop` report fired for `notifications` (~17 no-op pushes/s during the seed).
    Its resource is the collection's WINDOW, not the value; that is already how the window
    behaves under bulk inserts, with one subscriber.
