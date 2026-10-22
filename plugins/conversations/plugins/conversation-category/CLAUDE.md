# conversation-category

Classifies each conversation along a **user-defined set of categories**. One
category is chosen to paint the avatar on sidebar conversation rows. (The
per-category chips in the conversation header were removed; the classifications
are still stored for every category.)

Two words, used consistently everywhere:

- **Category** — one axis. `Priority`, `App`, `Type`. User-defined in
  `Settings → Conversation categories`; nothing is hardcoded.
- **Item** — one value inside a category. `P0`, `sonata`.

Every category is classified independently, so a conversation is a *bug* **and**
a *P0* **and** about *sonata* at the same time — the flat single-list version
had to cram those into combinatorial labels ("Bug (critical)") and still could
not say which app.

Each item carries a **hint**: free text handed to the classifier, so the model
uses the user's own definition of the item instead of guessing from its label
(`Name: "P0"`, `Hint: "Only use this if it impacts user revenue"`). Categories
carry a hint of their own for guidance about the axis as a whole.

## Avatar category

`avatarCategory` (a `dynamicEnumField` whose options are resolved at
config-render time from the user's own categories, via this plugin's
`DynamicEnum.Options` contribution) names the one category allowed to paint the
sidebar avatar. `Item.Avatar` is a first-match-wins dispatch slot — exactly one
disc per row — so making the choice explicit is what stops two categories from
fighting over it. Unset is legal: rows fall back to the title glyph.

The other categories are classified and stored, but not currently shown.

## How classification fires

A persistent global trigger on `conversationTurnCompleted` (contributed by this
plugin's `machine/` half) enqueues `conversation-category.classify` for every
assistant turn. The job makes **one** Haiku call covering every category that
still needs an answer, and asks for a JSON object keyed by category id —
`runClaudePrint` spawns a `claude` process per call, so one call per category
would multiply that by N for no accuracy gain.

Each category then resolves **independently**: a missing key or an unmatched
answer costs that one category, never the run. Whatever resolved is written; the
rest is retried on the next turn.

That "still needs an answer" predicate is what makes the job incremental — add a
category to config and only that category is asked about next turn, and the
steady state costs one indexed query and no model call at all. A **manual**
assignment is only ever replaced when the user re-classifies that specific
category, so "Re-classify all" can never stomp something set by hand.

**An unmatched answer writes nothing.** The single-category version fell back to
the last configured label ("keep a catch-all at the end"); per-category that is
a fabricated classification — `Priority: P0/P1/P2` has no catch-all, and
stamping `P2` on an unmatched reply invents data the user reads as the model's
judgement (and is exactly what `no-absorbed-failure` prohibits). Users who want
a catch-all say so in the category's hint: *"if unsure, pick Other"*.

## Boundary notes

- Storage is plugin-owned: `conversation_categories`, one row per
  (conversation, category), FK to `_conversations` with cascade-delete. NOT a
  1:1 `defineExtension` — that primitive's sole primary key is the parent id.
- The live read is `conversationCategories` (`core/internal/schemas.ts`), a
  lookup-only `liveCollection` keyed on `id` — it mints
  `conversation-categories:rows` alone, is served by
  `serveCollection(conversationCategories, { from: _conversationCategories })`
  (the projection is the row schema's keys, so `createdAt` stays server-only),
  and is read by `useCategoryRows` through `useLive(c, { ids })`.
- The primary key is the derived `categoryRowId(conversationId, categoryId)`
  rather than a composite, because a lookup collection's row id must be a
  single-column pk (the `:rows` point routing matches written pk values against
  each subscriber's id set). That keeps reads bounded: a sidebar row subscribes
  to the ONE avatar-category id.
- A row whose category was deleted from config is **structurally invisible** —
  no subscribed id set can contain it. That is why nothing sweeps orphans: a
  config write fires on every debounce in the settings form, so an automatic
  sweep would let "delete a category to retype its name" destroy every
  classification irrecoverably.
- The `item` column stores the item's **name**. Renaming an item in config
  orphans its rows and the stale label keeps rendering — losing a classification
  to a rename would be worse.
- Consumers (`stats/commits`) enumerate a category's items through the generic
  `itemOrder(config, categoryId)` / `getItemMap` API and never name one, so
  adding or removing a category needs no edit there. `itemOrder` is pure over
  the config value: the caller (a desktop server) reads
  `getConfig(conversationCategoryConfig)` itself.

## Portable and machine halves

`server/` is `portable: true` — it runs in the browser host too (the `/demo`
worker): the table, the `conversation-categories` collection, `getItemMap`, and
the clear route (a pure DB write). Everything that reads the categories config
(file-backed, so desktop-only until config is portable) or needs the computer is
`machine/`'s: `ConfigV2.Register`, the classify job and its turn-completed
trigger (the Haiku CLI), the configured avatars' saved-icon source, and the
classify and set routes — both endpoints declared `needsMachine`, so a client
on a host without the computer gets the unavailable arm instead of a 404.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Per-conversation categories: the sidebar row avatar painted from the category chosen for it. Auto-classified by Haiku after each turn. The conversation-category assignments, portable half: the categories config, the configured avatars' saved-icon source, the table, the lookup-only conversation-categories collection over it, the cross-plugin per-category item read, and clearing one assignment. The Haiku classifier and setting an item are the machine/ half's.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "config"
    - `DynamicEnum.Options` "Avatar category"
    - `Item.Avatar` → `CategoryAvatarRow`
  - Uses:
    - `config_v2.ConfigV2`
    - `config_v2.useConfig`
    - `conversations/conversation-ui/item.CONV_STATUS_DOT`
    - `conversations/conversation-ui/item.ConversationItemConv`
    - `conversations/conversation-ui/item.Item`
    - `fields/dynamic-enum/config.DynamicEnum`
    - `network/live.useLive`
    - `primitives/avatar.Avatar`
    - `primitives/css/status-dot.statusDotPaintClass`
    - `primitives/live-state.mapResource`
    - `primitives/live-state.ResourceErrorInline`
    - `primitives/live-state.ResourceResult`
  - Exports (types):
    - `Category`
    - `CategoryItem`
    - `ColorKey`
  - Exports (values):
    - `autoColorKey`
    - `useAvatarCategoryId`
    - `useCategories`
    - `useCategoryAvatars`
- Server:
  - Contributes:
    - `ConfigV2.Register` "config"
    - `resource.declare` "conversation-categories:rows"
    - `trigger` "conversation-category.classify"
  - Uses:
    - `config_v2.ConfigV2`
    - `config_v2.getConfig`
    - `config_v2.watchConfig`
    - `database.db`
    - `infra/endpoints.implement`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `network/live.serveCollection`
    - `tasks/tasks-core._conversations`
    - `ui/icons/saved-sources.defineSavedIconSource`
  - DB schema: `plugins/conversations/plugins/conversation-category/server/internal/tables.ts`
  - Exports (types): `CategoriesConfigValue`
  - Exports (values):
    - `conversationCategoriesEntity`
    - `conversationCategoryConfig`
    - `getItemMap`
    - `itemOrder`
  - Resources: `conversation-categories:rows` (keyed, point)
  - Routes: `DELETE /api/conversation-category/:conversationId/:categoryId`
- Machine:
  - Uses: `infra/endpoints.implementMachine`
  - Register: `defineJob('conversation-category.classify')`
  - Routes:
    - `POST /api/conversation-category/:conversationId/classify`
    - `POST /api/conversation-category/:conversationId`
- Core:
  - Uses:
    - `fields.FieldsRecord`
    - `fields.fieldsToZodObject`
    - `fields/date/config.dateField`
    - `fields/text/config.parsedTextField`
    - `fields/text/config.textField`
    - `infra/entities.entityRef`
    - `network/live.liveCollection`
  - Exports (types): `ConversationCategory`
  - Exports (values):
    - `conversationCategories`
    - `conversationCategoriesEntityRef`
    - `ConversationCategorySchema`
- Cross-plugin:
  - Imported by: `stats/commits`
- Exemptions:
  - Exempts itself from: `ids:pk-declared` — `server/internal/tables.ts` (debt)
- Shared:
  - Exports (types):
    - `ClassifyBody`
    - `ConversationCategory`
    - `SetCategoryItemBody`
  - Exports (values):
    - `categoryRowId`
    - `ClassifyBodySchema`
    - `classifyConversation`
    - `clearConversationCategory`
    - `conversationCategories`
    - `conversationCategoryConfig`
    - `ConversationCategorySchema`
    - `SetCategoryItemBodySchema`
    - `setConversationCategory`

<!-- AUTOGENERATED:END -->
