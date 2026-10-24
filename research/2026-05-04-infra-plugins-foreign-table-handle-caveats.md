# Foreign-table handle pattern: caveats and follow-ups

Companion to [`2026-05-04-plugins-foreign-table-handle.md`](./2026-05-04-plugins-foreign-table-handle.md) (design) and [`2026-05-04-infra-plugins-foreign-table-handle-plan.md`](./2026-05-04-infra-plugins-foreign-table-handle-plan.md) (plan). Captures what landed, what didn't, and what someone touching this code next should know.

## What's solid

- The active leak (`_taskAttachments` / `_conversationAttachments` re-exported from `tasks-core` and imported by `tasks` + `conversations`) is closed. The pgTables are not in any barrel; R4 mechanically forbids cross-plugin imports of `internal/` paths.
- The latent leak (`_agentAutoLaunchExt` barrel-exported from the toggle plugin) is closed.
- `handle-post-turn.ts`'s read-merge-write race is gone. `conversationAttachments.add` is one atomic `INSERT … ON CONFLICT DO NOTHING`.
- All 18 `./equin check` rules pass. Migration diff is empty (the underlying SQL schema is unchanged).

## Caveats

### 1. ~~`_tasksAutoStartExt` is still hand-rolled~~ — **Resolved**

**Resolved (2026-05-13).** drizzle-kit switched to `bunx`, eliminating the `Bun.which` crash. `tables.ts` now uses `defineExtension(_tasks, "auto_start", …)` and `mutations.ts` uses the handle's `.get()`, `.upsert()`, and `.delete()` methods. The only raw-drizzle query remaining is `claimAutoStart`, which needs `.returning()` on delete for atomic CAS — a legitimate use of the `.table` escape hatch.

### 2. `EntityExtension.upsert` is call-site generic on the patch type

The interface looks like this:

```ts
export interface EntityExtension<T extends ExtensionTable> {
  upsert<
    U extends Partial<Omit<InferInsertModel<T>, "parentId" | "createdAt" | "updatedAt">>,
  >(parentId: string, patch: U): Promise<InferSelectModel<T>>;
}
```

The original `upsertExtension` was a free function generic on T at the call site — `T` resolved to the specific table per call, so `Partial<Omit<InferInsertModel<T>, …>>` resolved cleanly.

When the same constraint moved onto a handle method (T captured at `defineExtension` time, not the call site), TypeScript started rejecting valid calls — `caveats` mysteriously got dropped from the inferred patch keys for `turnSummaries.upsert(…, { caveats, … })`. The closure either widened the captured T or eagerly evaluated `Omit<InferInsertModel<typeof table>, …>` against a stale form.

The fix is to make `upsert` itself generic on `U`, deferring patch-type resolution to the call site. TypeScript binds `U` to the literal object passed and checks it against `Partial<Omit<…>>` — which works, because the constraint is applied to the literal directly rather than to a captured-then-projected type.

**Drawback.** A reader sees `upsert<U>` and asks "why is upsert generic?" — the answer ("TS quirks with closure-captured generics") doesn't fit in a one-line comment. The interface is slightly more complex than necessary.

**Possible follow-up.** Investigate whether a more direct typing (e.g. `Partial<Pick<InferInsertModel<T>, Exclude<keyof InferInsertModel<T>, "parentId" | "createdAt" | "updatedAt">>>` instead of `Partial<Omit<…>>`) avoids the closure widening. Mostly cosmetic — the current shape works.

### 3. `.table` escape hatch is enforced behaviorally, not mechanically

The handle exposes `.table` so same-plugin code can compose richer drizzle queries (live-state resource loaders, complex SQL like `queue-ranks.ts`). Cross-plugin imports of the underlying pgTable itself are blocked by the boundary checker — the table never leaves `internal/`, R4 forbids cross-plugin `internal/` imports.

But the boundary checker doesn't catch a *handle* being imported across plugins and then `.table` accessed on it:

```ts
// hypothetical future code, R4 does NOT catch this:
import { taskAttachments } from "@plugins/tasks-core/server";
await db.select().from(taskAttachments.table).where(…);
```

The handle is a legal cross-plugin import; once you have it, `.table` is just a property access. The plugin-boundary checker has no rule for "don't reach `.table` on a foreign handle".

**Why this is OK today.** No code does this, and there's no incentive to — the protocol methods cover every existing use. The convention is documented in both CLAUDE.md files ("`.table` is for same-plugin raw queries").

**Why it's worth flagging.** Conventions decay. If a future feature needs an operation the handle doesn't have, the path of least resistance is "import the handle, reach `.table`, write the query". Once one place does it, it becomes the new norm. The doc's `[research/…/foreign-table-handle.md]` "Where the line is" section explicitly disclaims this — operations should land as named methods on the handle.

**Possible follow-up.** Add a targeted ESLint rule (or built-in check) that flags `<expr>.table` access where `<expr>` is imported from a `@plugins/<other>/server` barrel. Not urgent — no current violations — but cheap insurance.

### 4. Drizzle-kit discovery depends on a manual `_xxxTable` re-export

Each consumer must add `export const _xxxTable = handle.table` to its `tables.ts` / `schema-*.ts` so drizzle-kit's schema glob picks up the underlying pgTable (drizzle-kit walks file exports for pgTable instances and does not recurse into objects).

**Risk.** Forgetting this re-export silently drops the table from drizzle-kit's view: migrations stop being generated for it, the orphan sweep still works (because `linkSources` is registered at module-load time, independent of drizzle-kit), but schema-vs-code drift accumulates undetected until someone tries to ALTER the table.

**Mitigation today.** The `migrations-in-sync` check would catch the symptom on the *next* schema change — a column added to a forgotten table would not appear in the generated migration. But that's downstream of the loss.

**Possible follow-up.** Add a built-in check that scans every call to `Attachments.defineLink` / `EntityExtensions.defineExtension` and verifies the same module exports `<handle>.table`. Trivial to implement; closes the foot-gun.

### 5. ~~`auto-start/CLAUDE.md` carries stale prose~~ — **Resolved**

**Resolved (2026-05-13).** Caveat #1 is resolved — the description is now accurate.

### 6. `InferSelectModel<T>` / `InferInsertModel<T>` casts inside handle methods

Each method body has `as InferSelectModel<T>` (or `as Row`) on the returned row. Same in the originals — drizzle's runtime returns aren't typed as the model directly, so the cast bridges runtime to types.

**Risk.** If drizzle's behavior on optional/required columns changes between versions (e.g. `text(…).notNull().default("")` starts inferring as required-on-insert in a future drizzle release), the cast hides the discrepancy until something silently misreads.

**Why it's not addressed.** The originals had the same cast; this refactor preserved the surface area, not regression-tested it. Any drizzle major upgrade should re-run the typecheck without the casts to surface drift.

## Limitations of the design

### `add`/`set` are the only attachment write modes

`AttachmentLink` has no `remove`. No caller needs it today. Adding it is a 5-line method when one does. Don't pre-build.

### `EntityExtension` has no read-many

`get(parentId)` reads one row. Live-state resource loaders need all rows (current callers: `auto-launch/toggle/resource.ts`, `conversation-category/resource.ts`, `conversation-progress/resource.ts`, `turn-summary/resource.ts`, `queue/resource.ts`, `auto-start/resource.ts`). They use the `.table` escape hatch for a `db.select().from(handle.table)`.

This was deliberate (the agreed answer was to expose `.table` rather than grow the protocol with `entries()`/`getAll()`). But it concentrates raw query usage in resource loaders. If a future contributor imitates this pattern in a non-loader context, the `.table` escape grows beyond its intended scope.

**If it becomes painful.** Add a single `entries()` method returning `Row[]` to `EntityExtension`. That removes `.table` from every resource loader and shrinks the convention's surface to *just* `queue-ranks.ts` (the one place that genuinely needs composed SQL).

### No backpressure / batching on `set` and `add`

`set([…1000 ids])` runs one giant `INSERT … ON CONFLICT` and one `DELETE … WHERE NOT IN (…1000 ids)`. PostgreSQL handles this fine for the current call sites (typical `ids` lengths are 1-5), but a pathological large set would generate a 1000-element `IN` clause. Not a concern today; flag for later if attachment volume grows.

## Summary table

| Caveat | Impact | Effort to fix |
|---|---|---|
| ~~`_tasksAutoStartExt` not migrated~~ | ~~API inconsistency~~ | **Resolved** |
| `upsert<U>` call-site generic | Reader confusion | Low — investigate type alternatives |
| `.table` escape behavioral, not enforced | Future drift | Medium — new ESLint rule or check |
| `_xxxTable` re-export manual | Silent migration drop on omission | Low — new check on factory call sites |
| ~~`auto-start` CLAUDE.md prose~~ | ~~Stale doc~~ | **Resolved** |
| Drizzle inference casts in methods | Hidden drift on drizzle upgrade | Low — re-typecheck without casts on next bump |
| No `remove` on AttachmentLink | None today | Trivial when needed |
| No `entries` on EntityExtension | `.table` escape used in 6 resource loaders | Low — add one method |
| No batching on `set`/`add` | None today | Low if needed |

None of these are urgent. The active leak is closed; the design is correct; everything compiles and runs. This doc exists so the next person who touches the foreign-table primitives doesn't have to rediscover the constraints.
