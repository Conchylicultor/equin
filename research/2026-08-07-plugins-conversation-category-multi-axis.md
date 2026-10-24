---
title: Conversation categories — many axes, one avatar axis, per-item hints
date: 2026-08-07
category: plugins
---

# Conversation categories — many axes, one avatar axis, per-item hints

## Context

Today a conversation gets exactly **one** category. The list is user-configurable
(`Settings → Conversation categories`), Haiku picks one label after each assistant
turn, and that label paints both the chip in the conversation header and the avatar
disc on the sidebar row.

One label per conversation is too little. The same conversation is a *bug* **and**
a *P0* **and** about *sonata* — three independent questions that today have to be
crammed into one flat list ("Bug (critical)", "Feature (small)"), which combinatorially
explodes and still can't express "which app".

Three changes, all user-configurable, nothing hardcoded:

1. **Many categories.** The user defines any number of them — "Priority" with items
   P0/P1/P2, "App" with items sonata/page/…, "Type" with the current eight. Each is
   classified independently.
2. **One avatar category.** Only one category can paint the sidebar avatar, chosen
   explicitly in settings, so two categories can never fight over the same disc.
3. **Per-item hints.** Each item gets free text that is fed to the classifier —
   `Name: "P0", Hint: "Only use this if it impacts user revenue"` — so the model has
   the user's own definition of each item instead of guessing from the label.

The original design doc for this plugin already anticipated this:
*"a stepping stone toward Haiku-driven metadata for conversations more generally
(later: priority, area, complexity, …)"* —
[`research/2026-04-30-plugins-conversation-category.md`](2026-04-30-plugins-conversation-category.md).

### Decisions taken with the user

- **Sidebar rows: avatar only.** Non-avatar categories are visible in the conversation
  header, not on the list rows. (`Item.Chips` stays unwired; the dead
  `category-chip-row.tsx` gets deleted.)
- **Commits stats: one chart per category.** The stats pane renders a separate
  commits-breakdown chart for each configured category.
- **Auto-classify: one global switch**, as today. No per-category toggle.

## Terminology (used consistently in code, config and docs)

| Term | Means | Example |
|---|---|---|
| **Category** | one axis, user-defined | `Priority` |
| **Item** | one value within a category | `P0` |

The DB column that holds `"Bug (small)"` today is called `category`; it becomes
`item`, and the row gains a `categoryId`.

---

## 1. Config shape

`plugins/conversations/plugins/conversation-category/shared/config.ts`

```ts
defineConfig({
  fields: {
    autoClassify: boolField({ default: true, label: "Auto-classify with Haiku" }),

    avatarCategory: dynamicEnumField({
      label: "Avatar category",
      description:
        "Which category paints the avatar on sidebar conversation rows. Only one can, so the discs never conflict.",
      display: "radio",
    }),

    categories: listField({
      label: "Categories",
      stableIdentity: true,          // ids are durable DB keys — see §2
      itemFields: {
        name: textField({ label: "Name" }),
        hint: textField({
          label: "Hint",
          description: "Optional guidance for the classifier about what this category means.",
        }),
        items: listField({
          label: "Items",
          itemFields: {
            name: textField({ label: "Name" }),
            hint: textField({ label: "Hint", placeholder: "When should the model pick this?" }),
            avatar: avatarField({ label: "Avatar" }),
          },
          default: [],
        }),
      },
      default: [],
    }),
  },
});
```

**A nested `listField` is a proven pattern** — see
`plugins/review/plugins/code-review/shared/config.ts` (`sections[].patterns`) and
`plugins/primitives/plugins/data-view/shared/sort-presets-field.ts`
(`sortPresets[].rules`). `ListItemRow` renders every sub-field through the generic
`FieldRenderer`, so a nested list recurses into `ListRenderer` with no special-casing.

**The avatar picker's options are resolved at render time.** `dynamicEnumField` carries
no options; a `DynamicEnum.Options` contribution supplies them, matched by reference
equality on the field descriptor:

```ts
// web/index.ts
DynamicEnum.Options({
  field: conversationCategoryConfig.fields.avatarCategory,
  useOptions: useCategoryOptions,   // named hook in web/internal/use-category-options.ts
})
```

`useCategoryOptions` calls `useConfig(conversationCategoryConfig)` and returns
`[{ value: "", label: "None" }, ...categories.map(c => ({ value: c.id, label: c.name }))]`.
The `None` entry is load-bearing: without it a fresh install renders an empty radio
group that looks broken. Contribution shape mirrors
`plugins/ui/plugins/segmented-progress-bar/web/index.ts`.

> Pass a **named hook**, not an inline closure — `react-hooks` lint needs to see it as
> a hook, and barrel purity keeps logic out of `index.ts`.

---

## 2. Storage

`defineExtension` (`infra/entity-extensions`) is strictly 1:1 — `parent_id` is the sole
primary key and every handle method is `WHERE parent_id = ?`. It cannot host
`(conversationId, categoryId)`. Move to a plain plugin-owned table.

`server/internal/tables.ts` — replaces the extension:

```ts
export const _conversationCategories = pgTable("conversation_categories", {
  // `${conversationId}:${categoryId}` — a single-column PK so the point-resource
  // contract still holds (§3). Minted only by categoryRowId() in shared/.
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull()
    .references(() => _conversations.id, { onDelete: "cascade" }),
  categoryId: text("category_id").notNull(),
  item: text("item").notNull(),
  source: text("source", { enum: ["haiku", "manual"] }).notNull(),
  createdAt: ..., updatedAt: ...,
}, (t) => ({
  byConversation: index("conversation_categories_conversation_idx").on(t.conversationId),
  uniq: uniqueIndex("conversation_categories_conv_cat_idx").on(t.conversationId, t.categoryId),
}));
```

Precedents for a plugin-owned child table with FK cascade:
`plugins/active-data/server/internal/tables.ts`,
`plugins/page/plugins/links/server/internal/tables.ts`.

`shared/row-id.ts` (new) owns `categoryRowId(conversationId, categoryId)`. **Both
runtimes must import it** — the server writes the id and the client builds the same id
to subscribe; if they ever diverge the subscription silently reads nothing. Document
there that neither component may contain `:` or `,` (conversation ids are
`conv-<ts>-<slug>`; category ids are UUIDs from the settings UI or hand-authored slugs).

The `item` column stores the item **name**, exactly as `category` does today — keeps
the rows readable in `query_db` and makes the backfill a straight copy. Renaming an
item in config orphans its rows, which is already true today (12 live rows hold labels
dropped from config months ago) and is the tolerable failure: showing a stale label
beats losing a classification.

`server/internal/store.ts` (new) holds all the SQL in one place:
`getCategoryRows(conversationId)`, `upsertCategoryRows(conversationId, entries, source)`
(one multi-row `onConflictDoUpdate` on `id`, so one write = one change-feed event),
`deleteCategoryRow(conversationId, categoryId)`, and the cross-plugin
`getItemMap(categoryId)`.

---

## 3. Live resource — stays a bounded point resource

`windowQueryResource`'s point kind requires `point.by` to **be** the single-column
identity PK (the change feed routes writes by intersecting changed row ids with each
tuple's id set), and `usePointResource` narrows to `rows[0] ?? null`. One key = one row,
structurally — see
[`research/2026-07-18-global-bounded-working-set-resource-contract.md`](2026-07-18-global-bounded-working-set-resource-contract.md),
which names this very resource as the point pilot.

The derived `id` column keeps that contract intact:

```ts
windowQueryResource(descriptor, {
  from: t,
  select: { id: t.id, conversationId: t.conversationId, categoryId: t.categoryId,
            item: t.item, source: t.source, classifiedAt: t.updatedAt },
  point: { by: t.id },
});
```

One hook serves both surfaces —
`web/internal/use-conversation-categories.ts`:

```ts
useCategoryRows(conversationId, categoryIds): Map<categoryId, Row>
// built on usePointResources(resource, categoryIds.map(id => categoryRowId(conversationId, id)))
```

- **Sidebar row** passes `[avatarCategoryId]` — or `[]` when unset. One subscribed id
  per row, exactly today's budget. `encode([])` yields an empty id set and the compiled
  point loader short-circuits with no query, so "no avatar category chosen" needs no
  sentinel. (Do **not** pass an empty *string* id — `encode` throws on that.)
- **Header** passes every configured category id — one tuple, for the one open
  conversation.

Rejected alternative: a hand-written keyed-by-`conversationId` resource. Classification
is all `INSERT`s, and a keyed resource without `membership` FULL-recomputes on every
insert *per subscribed tuple* — i.e. once per mounted sidebar row. That is precisely
the fan-out the bounded-working-set contract exists to prevent.

**Rows whose `categoryId` was deleted from config become structurally invisible** —
no subscribed id set ever contains them. That is better than a GC sweep, and it is why
this plan adds **no orphan cleanup**: a config write fires on every debounce in the
settings form, so an automatic sweep would let "delete a category to retype its name"
destroy thousands of rows irrecoverably.

---

## 4. Classification — one Haiku call, per-category resolution

`runClaudePrint` spawns a `claude` process per call (~1–2s) and the job fires on
**every** assistant turn, so one call per category would multiply that by N for no
accuracy gain. Keep one call.

`server/internal/classify-job.ts`, input `{ conversationId?, categoryIds?, force? }`:

```
config = getConfig(...)                          // read FIRST — see below
targets = categories
  .filter(c => c.items.length > 0)
  .filter(c => !categoryIds || categoryIds.includes(c.id))
  .filter(c => force || !existing.has(c.id))
if (targets.length === 0) return                 // steady state: one indexed query, no spawn
```

Prompt lists only the target categories — each with its id, name, category hint, and its
items as `- "<name>" — <hint>` — and asks for **one JSON object keyed by category id**.
Parsing mirrors
`plugins/apps/plugins/events/plugins/sources/plugins/url-extract/server/internal/parse-response.ts`:
a string-aware brace scan (`isolateJsonObject`), `JSON.parse`, then
`z.record(z.string(), z.string()).safeParse`, with failures raised as
`NonRetryableError` carrying a bounded excerpt of the raw reply. Accept the category
*name* as a fallback key — models reach for the human-readable label.

**Each category resolves independently.** A missing key, an unmatched value, or an
empty item list skips that category only; whatever did resolve is written. That buys
fan-out's failure isolation at one process's cost.

**Manual rows are only overwritten when `force` is set *and* the category is named
explicitly**, so "re-classify all" never silently stomps a hand-set category.

Two fixes to fold in while in this file:

- `autoClassify` is currently read *after* `getConversation` + `readConversationTurns`,
  so a disabled plugin still pays two queries per turn. Read the config first, and gate
  on `!force && !config.autoClassify` so an explicit user re-classify still works with
  auto-classify off.
- **Drop the positional fallback.** `pickCategory` today returns the *last* configured
  label when nothing matches ("keep a catch-all at the end"). Per-category that becomes
  actively wrong — "Priority: P0/P1/P2" has no catch-all, and stamping `P2` on an
  unmatched reply is a fabricated classification, exactly what `no-absorbed-failure`
  prohibits. Rename to `match-item.ts` returning
  `{ ok: true; item } | { ok: false; reason }`; on `ok: false` write **nothing** for
  that category and log. The chip stays unset and the next assistant turn retries it
  automatically. Users express a catch-all through the category hint instead
  ("if unsure, pick Other") — which is what the new hint field is for.

  Accepted cost: a conversation the model can never match re-runs that category on every
  turn instead of settling once. The matcher is exact → prefix → substring and the prompt
  quotes the item names verbatim, so this should be rare; it is worth watching in
  Debug → Claude CLI Calls after rollout.

**Known gap, stated rather than hidden:** a newly added category is filled in on a
conversation's *next* assistant turn. Dormant conversations — most of the ~2,950 existing
rows — stay blank on it forever. No backfill affordance is in scope here; a
"classify everything unclassified" action is a sensible follow-up.

---

## 5. UI

**Header** — one contribution, N chips. `Conversation.Header` is a render slot and
`header-view.tsx` wraps it in `CollapsibleWrap rows={1}`, so a single contribution can
render a dynamic list. `CategoryChipToolbar` calls `useCategoryRows(convId, allIds)`
**once** and maps categories to a new `web/components/category-chip.tsx` (badge +
popover: item list with avatar and hint, Clear, "Re-classify this category",
"Re-classify all"). Each chip receives its row as a prop and calls no data hook.

> Return a **fragment**, not a wrapper `div` — `CollapsibleWrap`'s `effectiveChildren`
> walks through `display: contents` but not a normal element, so a wrapper becomes one
> wide unwrappable child.

Header density: eight other contributions already compete for that one row. Render
**set** categories as chips and collapse **all unset** ones behind a single muted
`＋ N` chip whose popover picks which to set. Screenshot the header before settling on
this (see Verification).

**Sidebar row** — `category-avatar-row.tsx` reads `useAvatarCategoryId()` and that one
row, keeping today's exact fallback contract (`colorless` when the item has an icon,
otherwise title-initial glyph tinted by `conv.id`). Delete
`web/components/category-chip-row.tsx` — it is unreferenced dead code and per the
avatar-only decision it stays that way.

---

## 6. Stats — one chart per category

`plugins/stats/plugins/commits` breaks commits down by category. Per the decision, it
renders one chart per configured category rather than picking a primary one.

- `shared/endpoints.ts` — `getCommitsCumulative` / `getCommitsRate` gain a
  `categoryId: z.string().optional()` query param alongside `breakdown: "category"`.
  The response's `categories: string[]` (the ordered series keys) is renamed `items`
  to match the new vocabulary.
- `server/internal/category-map.ts` — stop importing the `conversationCategory` handle
  and reaching into `.table` (the one hole through which this plugin's pgTable escapes
  today). Call `getItemMap(categoryId)` and `getItemOrder(categoryId)` from the
  conversation-category server barrel.
- `web/components/commits-section.tsx` — when "By category" is on, render one chart per
  configured category inside each of the existing "Over time" / "Per period" sections,
  each under a small heading with the category's name. Empty state when no categories
  are configured.
- `web/components/commits-category-charts.tsx` — both charts take a `categoryId` prop;
  `useCategoryColorFn` becomes `useCategoryAvatars(categoryId)`.

Stats never names a category — it enumerates them from the generic API, per the
collection-consumer separation rule.

---

## 7. Migration

### Config (hand-written, same commit)

There is **no automatic config migration**; a reshaped descriptor makes the committed
override stale and `config-origins-in-sync` is the forcing function. Rewrite
`config/conversations/conversation-category/config.jsonc` by hand, carrying the user's
existing eight labels into a category `Type`:

```jsonc
// @hash <value printed by the config-origins-in-sync failure>
{
  "autoClassify": true,
  "avatarCategory": "type",
  "categories": [
    {
      "id": "type",
      "name": "Type",
      "hint": "What kind of work this conversation is.",
      "items": [
        { "id": "type-general",  "name": "General question",     "hint": "", "avatar": { "icon": "question_mark", "color": "sky" } },
        { "id": "type-feat-s",   "name": "Feature (small)",      "hint": "", "avatar": { "icon": "star_outline",  "color": "amber" } },
        { "id": "type-feat-l",   "name": "Feature (big)",        "hint": "", "avatar": { "icon": "star_rate",     "color": "amber" } },
        { "id": "type-infra-s",  "name": "Infra (small)",        "hint": "", "avatar": { "icon": "factory",       "color": "emerald" } },
        { "id": "type-infra-l",  "name": "Infra (load bearing)", "hint": "", "avatar": { "icon": "factory",       "color": "emerald" } },
        { "id": "type-bug-s",    "name": "Bug (small)",          "hint": "", "avatar": { "icon": "bug_report",    "color": "rose" } },
        { "id": "type-bug-c",    "name": "Bug (critical)",       "hint": "", "avatar": { "icon": "bug_report",    "color": "rose" } },
        { "id": "type-other",    "name": "Other",                "hint": "", "avatar": { "icon": "question_mark", "color": "sky" } }
      ]
    }
  ]
}
```

> **Trap.** `normalizeCollectionItems` only walks **top-level** list fields and
> `config-stable-list-ids` only checks top-level lists. So the nested `items` rows get
> **no id from anywhere** — and `ListRenderer` keys React children, `SortableItem`, and
> its edit-matching on `item.id`, so id-less rows collide: editing one rewrites all of
> them. Every nested row above therefore carries an explicit hand-authored `id`, even
> though no check enforces it. Rows added later through the settings UI mint a
> `crypto.randomUUID()` and are fine. See Follow-ups.

`config.origin.jsonc` is regenerated by `./equin build` — never hand-write it.

### Database — three migrations, one commit, in this order

`entity-extensions/CLAUDE.md` suggests hand-editing generated SQL to reorder
CREATE-before-DROP. **That advice is stale** — `migrations/CLAUDE.md` states the
push-time hand-edit detector aborts on any edited schema migration. Use the documented
schema → data → schema sequence instead (timestamps order the runner, and sequential
builds produce increasing timestamps naturally):

1. Add the new `pgTable` while **keeping** `defineExtension`.
   `./equin build --migration-name add_conversation_categories`
2. `./equin build --custom-migration --migration-name backfill_conversation_categories --no-restart --skip-checks`,
   then hand-edit the generated empty SQL (data migrations are *meant* to be hand-edited):
   ```sql
   INSERT INTO conversation_categories
     (id, conversation_id, category_id, item, source, created_at, updated_at)
   SELECT parent_id || ':type', parent_id, 'type', category, source, created_at, updated_at
   FROM conversations_ext_category
   ON CONFLICT (id) DO NOTHING;
   ```
   The deterministic id + `ON CONFLICT DO NOTHING` is load-bearing: data migrations are
   re-hashed and re-applied whenever their content changes, so they must be idempotent.
   Never `gen_random_uuid()` here.
3. Remove `defineExtension` from `tables.ts`, then
   `./equin build --migration-name drop_conversations_ext_category`.

**Do not pass `--reset-migration`** — it would drop the branch-local schema migration
from step 1.

Live volume, for sizing: 2,952 rows across 11 distinct labels, three of which are no
longer in config. The backfill carries those over verbatim, which is correct — they
render as stale labels rather than vanishing.

---

## 8. File-by-file

**`plugins/conversations/plugins/conversation-category/`**

| File | Change |
|---|---|
| `shared/config.ts` | new shape (§1); retire the "last label is the fallback" prose |
| `shared/row-id.ts` | **new** — `categoryRowId()`, used by both runtimes |
| `shared/schemas.ts` | row schema `{ id, conversationId, categoryId, item, source, classifiedAt }`; descriptor pk field → `"id"` |
| `shared/endpoints.ts` | `SetCategoryBody` → `{ categoryId, item }`; DELETE → `/:conversationId/:categoryId`; classify gains optional body `{ categoryIds? }` |
| `shared/index.ts` | re-export the renamed symbols + `categoryRowId` |
| `server/internal/tables.ts` | plain `pgTable` (§2) |
| `server/internal/store.ts` | **new** — all SQL |
| `server/internal/resource.ts` | `point: { by: t.id }` |
| `server/internal/pick-category.ts` | → `match-item.ts`, discriminated result, no positional fallback |
| `server/internal/parse-classification.ts` | **new** — brace scan + zod validate |
| `server/internal/classify-job.ts` | one combined call, per-category resolution (§4) |
| `server/internal/routes.ts` | two-level validation (§ below); per-category DELETE |
| `server/index.ts` | drop the handle export; export `getItemMap`, `getItemOrder`, `getCategories`, `getAvatarCategoryId` |
| `web/internal/use-conversation-categories.ts` | replaces `use-category.ts` |
| `web/internal/use-category-avatars.ts` | `useCategoryAvatars(categoryId)` + `useAvatarCategoryId()` |
| `web/internal/use-category-options.ts` | **new** — the `DynamicEnum.Options` hook |
| `web/internal/api.ts` | `setCategoryItem`, `clearCategory`, `reclassify(convId, categoryIds?)` |
| `web/components/category-chip.tsx` | **new** — one category's chip + popover |
| `web/components/category-chip-toolbar.tsx` | fragment of N `<CategoryChip>` |
| `web/components/category-avatar-row.tsx` | reads the avatar category's row |
| `web/components/category-chip-row.tsx` | **delete** (dead) |
| `web/index.ts` | add the `DynamicEnum.Options` contribution; update exports |
| `CLAUDE.md` | rewrite the hand-written prose (terminology, subscription shape, no positional fallback) |

`handleSetCategory` validates on two levels now: `categoryId` must be a configured
category **and** `item` must be one of *that* category's item names, each rejected with
a `HttpError(400)` naming which failed. The new per-category DELETE deliberately does
**not** validate against config — deleting an orphan row is exactly when you need it.

**`plugins/stats/plugins/commits/`** — `shared/endpoints.ts`,
`server/internal/category-map.ts`, `server/internal/handle-rate.ts`,
`server/internal/handle-cumulative.ts`, `web/components/commits-section.tsx`,
`web/components/commits-category-charts.tsx` (§6).

**`config/conversations/conversation-category/config.jsonc`** — hand-rewritten (§7).

**Regenerated by `./equin build`, never hand-edited:** `docs/plugins-*.md`, the
`AUTOGENERATED` blocks in every `CLAUDE.md`, `web.generated.ts` / `server.generated.ts`,
`config.origin.jsonc`, `meta/_journal.json`.

---

## 9. Verification

1. `./equin build` — must end with `BUILD OK`; confirm via the deploy receipt at
   `~/.singularity/worktrees/<wt>/build-status.json` (`status: ok`).
2. `./equin check` — `migrations-in-sync`, `config-origins-in-sync`,
   `config-stable-list-ids`, `data-migration-dml-only`, `migration-applies-clean`,
   `plugins-doc-in-sync`, `type-check`, `plugin-boundaries`.
3. **Backfill** — `query_db`:
   `SELECT count(*), count(DISTINCT item) FROM conversation_categories WHERE category_id = 'type'`
   should return 2952 / 11, and `conversations_ext_category` should no longer exist.
4. **Settings** — open `http://<worktree>.localhost:9000` → Settings → Config →
   conversation-category. Add a second category ("Priority" with P0/P1/P2 and hints),
   confirm the nested item editor adds/reorders/edits rows independently (this is the
   nested-id trap), and confirm the new category appears in the "Avatar category" radio.
5. **Header** — open a conversation; both chips render, each popover sets its own item,
   and the sidebar avatar changes only when the *avatar* category changes. Screenshot to
   judge header density:
   ```bash
   bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --url http://<worktree>.localhost:9000/agents/c/<id> --out /tmp/cat-header
   ```
6. **Classification** — clear a conversation's rows, send a turn, then check
   Debug → Claude CLI Calls: exactly **one** call, its prompt carrying both categories
   with their hints, and its reply a JSON object keyed by category id. Then delete only
   the Priority row and send another turn — the next call must ask for Priority only.
7. **Stats** — Stats → Commits → "By category": one chart per configured category, each
   with its own item series and colors.
8. `./equin test plugins/conversations/plugins/conversation-category` — add
   `bun:test` coverage for `matchItem` (exact/prefix/substring/no-match) and
   `parse-classification` (fenced JSON, chatty preamble, malformed) next to the source.

---

## 10. Follow-ups to file (not in scope here)

Per the repo's "don't memorize gotchas — remove the footgun" rule, three structural
fixes this work surfaces:

1. **Nested config list rows get no id from anywhere.** `normalizeCollectionItems`
   doesn't recurse and `config-stable-list-ids` doesn't walk nested lists, yet
   `ListRenderer` keys React children, dnd-kit ids, and edit-matching on `item.id` — so
   hand-authored nested rows silently collide. Either make the normalizer recurse or
   extend the check.
2. **`entity-extensions/CLAUDE.md` documents a migration procedure that the push-time
   hand-edit detector now rejects.** Replace it with a pointer to the schema → data →
   schema sequence.
3. **`dynamic-enum`'s radio renderer hardcodes `name="dynamic-enum-field"`** — a global
   native radio-group name, so two radio dynamic-enums on one settings page share a
   group. Masked today by the controlled `checked`, but latent.

Also worth a task, from §4: a **"classify all unclassified conversations"** action, so
adding a category can reach conversations that will never get another turn.
