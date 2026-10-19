# ids

Every minted id is `<prefix>-<body>`, declared ONCE with `defineIdKind` in the
owning plugin's `core/`. The mint, the branded type, validation and inline
recognition all derive from that one declaration, so a mint and the readers of
its shape (chips, name parsers, e2e scripts) cannot drift apart — the failure
the retired `block-\d+-[a-z0-9]{4,8}` chip pattern shipped, silently. Plan:
[`research/2026-10-07-global-unified-prefixed-ids.md`](../../research/2026-10-07-global-unified-prefixed-ids.md).

```ts
// plugins/<owner>/core/id-kinds.ts
export const songIdKind = defineIdKind({ prefix: "song", label: "Song" });
songIdKind.mint();            // Id<"song">  e.g. "song-1791400000-0a9zk2"
songIdKind.is(s);             // anchored: is this whole string a song id?
songIdKind.parse(s);          // the boundary parse — throws IdParseError
songIdKind.schema;            // the same, as a zod schema (endpoints, route params)
songIdKind.pattern;           // unanchored inline RegExp (own prefix only) — compose with inlineBoundary()
songIdKind.recognitionPattern; // pattern + aliases, for an anchored reading of a known kind
songIdKind.key(s);            // a STORED id to look a row up by — branded, not validated
songIdKind.stampedAtMs(id);   // when a stamped id was minted (seconds and legacy millis alike)
type SongId = IdOf<typeof songIdKind>;
```

## Shapes mint; recognition is generic

A kind picks one of three closed SHAPES for what it mints:

| shape | mint | for |
|---|---|---|
| `stamped` (default) | `<prefix>-<epochSeconds>-<6 base36, zero-padded>` | an entity a person or agent names — short, sortable, readable in prose |
| `uuid` | `<prefix>-<uuid v4>` | bulk / client-side mints (page blocks), high-rate plumbing |
| `hash` | `mint(digest)` → `<prefix>-<hex>` | content-addressed ids |

But RECOGNITION is the same body for every kind: a stamped body
(`\d{9,13}-[a-z0-9]{4,8}`, i.e. epoch seconds or millis with a 4–8 char suffix)
or a uuid, plus a 32–64 hex digest for `hash` kinds. So every legacy body a kind
ever minted (`task-<ms>-<6>`, `att-<s>-<4>`, `block-<ms>-<6>`) and the
`<prefix>-<uuid>` a bare-uuid rewrite produces stay recognised with no kind
declaring a legacy regex of its own. A kind can change its shape without its old
rows going dark.

- **Aliases** (`aliases: ["claude"]`) are recognition-only legacy prefixes,
  never minted. An alias also accepts the bare-epoch body (`claude-<epoch>`, the
  oldest worktree/session names). They are read only where the caller already
  KNOWS the kind — `is`, `parse`, `schema`, `recognitionPattern` (a worktree
  name, a tmux session) — and NEVER by `kind.pattern`, the inline reading chips
  and `detectIds` use: text cannot say which kind a `claude-…` is. That is what
  lets two kinds share an alias (`claude` named both an attempt and its
  conversation); an alias may still not be another kind's prefix
  (`ids:prefix-unique`). `kind.prefixes` is the prefix then the aliases, for a
  namespace test that deliberately does not check the body.
- **`legacyBareUuid: true`** makes `parse` / `schema` — and `key` — upgrade a
  bare uuid to `<prefix>-<uuid>`, so old URLs keep resolving after a rewrite.
  Declare it only on a kind whose stored rows WERE rewritten (phase 4: song,
  bkmk, bhist, mail*, evrun, sess, ver, trash): `key` upgrading a bare uuid
  would miss a row still stored bare.
- **The pattern's one built-in guard is leading**: no letter, digit, `_` or `-`
  right before the prefix (`legacy-claude-…`, `xtask-…` are not ids, not even
  for `is`). Inline
  readings add `inlineBoundary()` (no `/` either side, no dotted suffix — a
  sentence's full stop is fine); `detectIds(text, kinds)` is that reading over a
  set of kinds, earliest-then-longest wins.
- Prefix grammar `/^[a-z][a-z0-9]{1,9}$/`, asserted at define time.
- **Three ways in, one per boundary.** A NEW id comes from `mint()`. An id a
  caller hands you to STORE goes through `parse` / `schema` (validated). An id
  you only LOOK UP by (a route param, a column of another table) goes through
  `key()`, which brands without validating: the database is the authority on
  the ids it holds, and live tables carry rows minted before their kind
  (`crash-…` reports, `<commit>-<ms>` builds) — an unknown key simply finds no
  row. `key()` is never a source for an INSERT.
- **`stampedAtMs(id)`** is the one reading of a stamp. The mint moved from
  epoch millis to seconds, so a hand `split("-")[1]` would rank every new id as
  the oldest; the kind reads both.

## The registry (open set ⇒ slots)

Kinds are an open set — any plugin declares one — so consumers read slots, never
a list:

- **`IdKinds.Kind({ kind })`**, web and server. The owner registers its kinds on
  BOTH runtimes (`ids:kind-both-runtimes`); `useIdKinds()` / `getIdKinds()` read
  them at call time.
- **`IdKinds.Presenter`** (web): how a kind's ids are shown and opened — `icon?`,
  `useReferent(id)` → `loading | found{title} | missing | failed`, `useTarget()` →
  `(id) => LinkTarget` (a link, so a chip honours ⌘/middle-click). Optional per kind, and separate from the kind so `ids` stays
  below the UI.
- **`IdKinds.Referent`** (server): `resolve(id)` → `{found, title}`. Every
  presented kind has one (`ids:presenter-has-referent`, joined on the prefix).

A family does not contribute Presenter / Referent by hand: `active-data/id-chip`'s
`idChip(...)` / `idChipServer(...)` mint them together with the kind's inline
chip and its page-editor / model-text halves.

## Columns and fields

- `idColumn(kind, { sqlDefault? })` (server) — the table's text PK typed
  `Id<P>`; `sqlDefault` (uuid kinds) has the database mint
  `'<prefix>-' || gen_random_uuid()`.
- `idRef(kind, name, () => parent.id, { onDelete })` (server) — a FK column typed
  `Id<P>`, **`onUpdate: "cascade"` by default**, so a later rewrite of the
  parent's ids carries every child row.
- `idKindField(kind)` (core, because field records are web-safe) — the id field
  of a `defineEntity` record. Its decoder BRANDS, it does not validate: the
  database is the authority on the ids it already holds (live tables carry
  hand-made ids such as `task-meta-crashes`), and a read must never throw.

`idColumn` / `idKindField` are DDL-identical to `text("id")` (no migration), so
phase 2 keyed the already-prefixed tables by their kinds (agents, launches,
summaries, groups, releases, reports, notifications, reviews, deployments,
deploy runs, event sources, events). `idRef` changes FK DDL (`ON UPDATE
CASCADE`) and lands in phase 3.

## Which column is declared — `ids:pk-declared`

The check reads the BUILT tables: a probe subprocess loads every schema file
the way drizzle-kit does and asks each table's single-column `id` primary key
`idColumnDeclaration(column)` (server) — a kind (its decoder is a
`storedIdSchema`, recognised through sql-column's `columnSchema`), external
(`externalIdColumn`), or undeclared. So a `defineEntity` whose field record
lives in another module counts like an inline `idColumn`. An undeclared table
is reported by the schema file that exports it, which is where its plugin's
`exempt/index.ts` debt entry points.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The id-kind registry, web half: IdKinds.Kind registers a declared kind and IdKinds.Presenter how its ids render and open (icon, useReferent, useTarget); useIdKinds() / useIdPresenters() read them at render time. The id-kind registry, server half: IdKinds.Kind registers a declared kind and IdKinds.Referent resolves a kind's id to its title; getIdKinds() reads them at call time. idColumn / idRef are a kind's drizzle primary-key and foreign-key columns (typed Id<P>; idRef cascades on update).
- Web:
  - Slots:
    - `IdKinds.Kind`
    - `IdKinds.Presenter`
  - Slot contributors: 36 contributors — full list in [REFERENCE.md](./REFERENCE.md)
    - `IdKinds.Kind` ×27
    - `IdKinds.Presenter` ×9
  - Exports (types):
    - `IdPresenter`
    - `IdReferentState`
  - Exports (values):
    - `IdKinds`
    - `useIdKinds`
    - `useIdPresenters`
- Server:
  - Uses:
    - `database/sql-column.columnSchema`
    - `database/sql-column.parsedText`
  - Exports (types):
    - `IdColumnDeclaration`
    - `IdReferent`
  - Exports (values):
    - `externalIdColumn`
    - `getIdKinds`
    - `idColumn`
    - `idColumnDeclaration`
    - `IdKinds`
    - `idRef`
- Core:
  - Uses:
    - `fields.ExactOptions`
    - `fields.FieldDef`
    - `fields.FieldMarks`
    - `fields.FieldMeta`
    - `fields.FieldType`
    - `fields.pickMeta`
    - `fields/text.textFieldType`
  - Exports (types):
    - `AnyIdKind`
    - `DetectedId`
    - `Id`
    - `IdKind`
    - `IdOf`
    - `IdShape`
  - Exports (values):
    - `defineIdKind`
    - `detectIds`
    - `externalIdField`
    - `ID_PREFIX_RE`
    - `ID_SHAPES`
    - `idKindField`
    - `IdParseError`
    - `inlineBoundary`
    - `kindLabel`
    - `parseKindLabel`
    - `storedIdSchema`
- Cross-plugin:
  - Imported by: 32 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×10
    - `conversations` ×5
    - `primitives` ×3
    - `build` ×2
    - `page` ×2
    - `release` ×2
    - `tasks` ×2
    - `active-data/id-chip`
    - `history/engine`
    - `infra/trash`
    - `plugin-meta/plugin-health`
    - `reports`
    - `shell/notifications`

<!-- AUTOGENERATED:END -->
