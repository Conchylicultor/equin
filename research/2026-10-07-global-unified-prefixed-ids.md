# Unified prefixed ids — `defineIdKind`

## Context

Ids are minted ad hoc across the repo, in four inconsistent families:

- **Prefixed, stamped** — `task-<ms>-<6>`, `att-/conv-<s>-<4>`, `proto-<s>-<4>` (padded), `agent-`, `launch-`, `build-`, `report-`, `notif-`, `release-`, `summary-`, `cgrp-`, `review-`, `dpl-`, `drun-`, `srv-`, `evs-` — same idea, four body shapes, each mint a hand-written template literal (a second `task-` mint with a third shape lives in `tasks-core/server/internal/mutations/cross-table.ts:90`).
- **Prefixed, other body** — `block-<uuid>`, `evt-<sha32>`, config ids `view-/preset-/cc-<uuid>`.
- **Bare UUID** (text or `uuid` columns) — `sonata_songs`, `attachments`, `backup_runs`, `mail_*`, `browser_*`, `event_source_runs`, `supervised_job_runs`, `entity_versions`, `trash_entries`, `conversation_sessions`, `page_reminders`, plus the plumbing tables (`traces`, `slow_ops`, `claude_cli_calls`, `analytics_*`, `chord_answers/rounds`, `latency_ledger_*`, every `*_triggers` table).
- **External / natural / composite** — Gmail, YouTube, Claude session ids, integer keys, `pushes` (`uuid:sha`). **Out of scope.**

Recognition is just as scattered: each active-data chip re-types its regex (`active-data/plugins/{attempt,conv,task-link,page-link,prototype}/core/pattern.ts`), pinned to the mint only by a per-family test; `WORKTREE_NAME_RE`, `SESSION_NAME_RE`, `handle-delete.ts` and `AGENT_SESSION_RE` re-type the `att|conv|claude` shapes again. There is no registry of id kinds and no generic "what is this id, how do I open it" path — each chip hand-wires its resolve and pane.

**Goal:** every minted id is `<prefix>-<body>`, declared once with `defineIdKind`; mint, branded type, parse/validation and inline recognition all derive from that declaration, so any surface can detect and open any id across apps. Bare-UUID rows are rewritten where cheap.

## Design

### 1. The primitive — new top-level plugin `plugins/ids`

`core/` (dependency-free, browser-safe):

```ts
export const songId = defineIdKind({
  prefix: "song",            // /^[a-z][a-z0-9]{1,9}$/, no hyphen, unique repo-wide
  label: "Song",             // shown by generic chips / pickers
  shape: "stamped",          // default; see shapes below
  aliases: [],               // recognition-only legacy prefixes, e.g. ["claude"] for att/conv
  legacyBareUuid: false,     // true for kinds whose old rows were bare uuids → parse() upgrades them
});
songId.mint();               // Id<"song">
songId.is(s); songId.parse(s); // anchored check / boundary parse (throws), upgrades legacy forms
songId.schema;               // zod schema → Id<"song"> (endpoints, route params, config)
songId.pattern;              // unanchored core RegExp fragment (compose with inlineBoundary)
type SongId = IdOf<typeof songId>; // = Id<"song"> = string & { readonly __idKind: "song" }
```

**Shapes** (a closed set in core; a kind picks one, default `stamped`):

| Shape | Mint | Use when |
|---|---|---|
| `stamped` (default) | `<prefix>-<epochSeconds>-<6 base36, zero-padded>` | entity a person/agent names — short, creation-sortable, readable in prose |
| `uuid` | `<prefix>-<uuid v4>` | bulk or client-side mints where per-second collision matters (page blocks, filter-tree nodes, high-rate plumbing) |
| `hash` | `<prefix>-<caller-supplied hex digest>` | content-addressed / dedupe ids (`evt-`) — `mint(digest)` |

**Recognition is generic, not per kind:** every kind's pattern is `(?:prefix|alias)-(?:\d{9,13}-[a-z0-9]{4,8}|<uuid>|<hex32+ for hash kinds>)`. This accepts every live legacy body (task ms/6, att/conv s/4, old `block-<ms>-<6>`, `block-<uuid>`) and the `<prefix>-<uuid>` form the rewrite migration produces — so no kind needs a hand-written legacy regex. The stamped mint fixes the short-suffix wart (padStart, as `prototypes/plugins/files/core/id.ts` already does).

**Registry** — kinds are open-set (any plugin adds one), so they are contributed, never enumerated by consumers:
- `IdKinds.Kind(kind)` slot in `web/` and `server/`; `useIdKinds()` / `getIdKinds()` read it at call time.
- `detectIds(text, kinds) → { kind, id, start, end }[]` in core (inlineBoundary semantics; earliest-longest wins).
- `server/`: `idColumn(kind)` (text PK, `$type<Id<P>>`, optional SQL default `'<prefix>-' || gen_random_uuid()` for `uuid`-shape DB-minted plumbing) and `idRef(kind, { onDelete })` (FK column typed `Id<P>`, **`onUpdate: "cascade"` by default**); `idKindField(kind)` for `defineEntity` field sets (`plugins/infra/plugins/entities`).

**Checks / lint** (in `ids/check`, `ids/lint`):
- `ids:prefix-unique` — no two kinds (or aliases) share a prefix.
- `ids:kind-both-runtimes` — a kind contributed on web is contributed on server and vice versa.
- `ids:pk-declared` — every single-column `id` PK of a schema table is `idColumn`/`idKindField`, or `externalIdColumn({ reason })` (Gmail, YouTube, integer keys, composites). Unmigrated tables are listed as `debt` in their own `exempt/index.ts` with a task, so the rule is on from day one and the debt is visible.
- The branded column type makes `insert({ id: crypto.randomUUID() })` a tsc error — the kind's `mint()` is the only way to produce one (supersedes `page-editor/no-adhoc-block-id`, which is then deleted).

### 2. Generic chips — cross-app detection and open

- Presentation is a separate, optional contribution so `ids` stays below the UI: `IdKinds.Presenter({ kind, icon, useReferent(id) → loading|found{title}|missing, open(id), component? })` in web; `IdKinds.Referent({ kind, resolve(id) → {found,title} })` in server.
- New `active-data/plugins/id-chip` registers the inline chip(s) from the presenter slot (pattern = `inlineBoundary(kind.pattern)`), contributes `Editor.InlineToken` + `InlineTokenReferentSource` from the referent slot — replacing the hand-wired triple in each family.
- Existing chip plugins (`attempt`, `conv`, `task-link`, `prototype`, `page-link`) shrink to a presenter + referent; `attempt` keeps its custom component via `component`. `page-link` keeps its runtime page/block split inside `open`.
- `active-data/check` (`document-chip-has-server-token`, `resolved-chip-has-referent`) is rewritten to join on `kind.prefix` instead of `pattern.source`.

### 3. Kind inventory

Declared in the **owning plugin's `core/`** (e.g. `tasks-core/core/id-kinds.ts` exports `taskId`, `attemptId`, `conversationId`; replaces `id-mint.ts`).

| Kind (prefix) | Owner | Shape | Existing rows |
|---|---|---|---|
| task, att (alias claude), conv (alias claude) | tasks-core | stamped | kept, recognised |
| proto | prototypes/files | stamped | kept (folder names) |
| block | page/editor | uuid | kept (opaque by policy; recognised) |
| agent, launch, summary, cgrp | conversations/* | stamped | kept |
| build, release, report, notif, review | their plugins | stamped | kept |
| dpl, drun, srv | apps/deploy | stamped | kept |
| evs (stamped), evt (hash) | apps/events | — | kept |
| view, preset, cc (uuid), fnode (uuid) | data-view | uuid | config: kept (`fnode` new mints only) |
| song | sonata/library | stamped, `legacyBareUuid` | **rewrite** (`seed-` starters stay as `seed-…`: declare `seed` as an alias) |
| bkmk, bhist | browser | stamped / uuid | **rewrite** |
| mailacct, mailatt, maildraft, mailout | mail | stamped / uuid | **rewrite** (tables ~empty) |
| evrun | events/refresh | stamped, `legacyBareUuid` | **rewrite** (route `run/:runId`) |
| sess | session-chain | uuid | **rewrite** (row id only; `claudeSessionId` untouched) |
| ver, trash | history/engine, trash | uuid | **rewrite** |
| attach | attachments | stamped | **forward-only** — id is in disk filenames, `disk_path`, and `/api/attachments/<id>` inside stored markdown/page JSON |
| rem | page/inline-date | uuid | **forward-only** — id is the `[[reminder:<id>:…]]` token in page text |
| sjrun, bkrun | supervised-job, backup | uuid / stamped | **forward-only** — id names transcript/marker files of in-flight runs |
| trace, slowop, cli, hit, visit, chans, chround, latency, emit, trig (all `*_triggers`, one edit in `infra/events/server/internal/base-columns.ts`), boot | plumbing | uuid | **rewrite** (uuid → text column, then prefix) |

Prefixes above are proposals; final names are bikeshed-able in phase 1 review. Existing short prefixes (`dpl`, `drun`, `srv`, `evs`, `cgrp`, `notif`) are kept — renaming them is a rewrite with no detection benefit.

### 4. Rewriting existing rows

Because recognition accepts `<prefix>-<uuid>`, the rewrite is just **prepend the prefix** — idempotent by construction (`WHERE id NOT LIKE 'song-%'`), fork-safe per the migrations doc.

- **FKs:** every FK today is `ON UPDATE NO ACTION`. `idRef` defaults to `onUpdate: "cascade"`, so adopting it on child columns is a drizzle-generated schema migration. That must land **in an earlier push** than the data migration (a claimed data migration runs between expand and contract, before constraint changes apply). Then `UPDATE sonata_songs SET id = 'song-' || id WHERE …` cascades through all `sonata_songs_ext_*`, track-mixer, attachment link tables.
- **Soft refs (no FK)** are updated explicitly in the same data migration: `sonata_ug_tabSaved` `song_id`, track-mixer `songId` copies, `mail_outbox.target_id`, `trash_entries.root_entity_id` / `entity_versions.entity_id` only if they point at a rewritten kind (they point at page ids today — untouched).
- **uuid-typed plumbing:** schema migration changes `id uuid` → `text` (drizzle `SET DATA TYPE text`), then a data migration prefixes. These tables are small (largest: slow_ops 7k rows, traces 3.8k rows / 2 MB of index) and retention-swept.
- **URLs / bookmarks:** `kind.parse()` upgrades a bare uuid to `<prefix>-<uuid>` for `legacyBareUuid` kinds, so old `/sonata/song/<uuid>` links keep working.
- **Live-state snapshot / caches:** the change feed fires on the UPDATE; nothing extra. Worktree forks taken before the rewrite apply it on their next boot.

### 5. Cost of unifying everything (the plumbing question)

- **Performance:** negligible. A prefixed text id is ~20 bytes larger than a 16-byte uuid; across the biggest plumbing table that is ~150 kB of index. No hot path compares ids by anything but equality.
- **Code complexity:** low. Plumbing tables get `idColumn(kind)` with the SQL-default variant, so DB-side minting (`defaultRandom()`) keeps working; the 9 trigger tables share one base-columns edit.
- **Benefit:** the rule becomes universal and therefore checkable: `ids:pk-declared` has no judgement call about what is user-facing. Trace / slow-op / CLI-call ids do get pasted by agents while debugging, so detection pays off there too.
→ Unify everything; plumbing is the last phase.

## Phases (each one a task, each shippable alone)

1. **Primitive + core kinds + generic chip.** `plugins/ids` (core, web, server, check, lint); `task/att/conv/proto/block` kinds; `id-chip` replaces the five hand-wired chips; `WORKTREE_NAME_RE`, `SESSION_NAME_RE`, `AGENT_SESSION_RE`, `handle-delete.ts`, `build/e2e/runs-surface.ts` read the kinds; delete `id-mint.ts`, the cross-table task mint, `no-adhoc-block-id`. `ids:pk-declared` on, every other table exempted as debt.
2. **Declare the already-prefixed kinds** (agent, launch, summary, cgrp, build, release, report, notif, review, dpl, drun, srv, evs, evt, view, preset, cc, fnode) — mint swaps + `idColumn`; presenters where a pane exists (report, build, deployment…).
3. **FK `onUpdate: cascade` push** — move child FK columns of rewrite-kinds onto `idRef`.
4. **Rewrite cheap bare-uuid kinds** — song, bkmk, bhist, mail*, evrun, sess, ver, trash: kinds + one data migration per family.
5. **Forward-only kinds** — attach, rem, sjrun, bkrun: new mints prefixed; resolvers (`resolve-prompt-attachments.ts`, reminder reconciler, `/api/attachments/:id`) accept both forms.
6. **Plumbing** — uuid → text + prefix for traces, slow_ops, claude_cli_calls, analytics, chord, latency, emissions, triggers, boot traces. Exemption list empty → debt cleared.

## Critical files

- New: `plugins/ids/{core,web,server,check,lint}/`, `plugins/active-data/plugins/id-chip/`
- Template to follow: `plugins/apps/plugins/prototypes/plugins/files/core/id.ts` (one module owns mint + pattern)
- `plugins/tasks/plugins/tasks-core/core/id-mint.ts` (→ `id-kinds.ts`), `.../server/internal/mutations/cross-table.ts`
- `plugins/active-data/core/inline-id-pattern.ts` (`inlineBoundary`, reused), `plugins/active-data/plugins/*/core/pattern.ts` (deleted), `plugins/active-data/check/index.ts`
- `plugins/primitives/plugins/text-editor/plugins/inline-chip/{web/internal/inline-registry.ts,server/internal/referents.ts}` (consumed unchanged)
- `plugins/page/plugins/editor/core/block-id.ts`, `.../lint/no-adhoc-block-id.ts`
- `plugins/infra/plugins/entities/server/internal/define-entity.ts` (`onUpdate` already forwarded)
- `plugins/infra/plugins/events/server/internal/base-columns.ts` (all trigger tables)
- `plugins/infra/plugins/worktree/core/internal/worktree-name.ts`, `plugins/conversations/plugins/runtime-tmux/server/internal/{pane-status,pane-rows}.ts`, `plugins/conversations/server/internal/handle-delete.ts`
- Migrations: data migrations via `./equin build --custom-migration --migration-name <slug>`; precedent `plugins/database/plugins/migrations/data/20260603_150847_c72bb218__reorder_plugin_id_path_rename.sql` and the fork-safety header of `20260807_005217_4ff1ca12__rename_agent_notes_block_type.sql`

## Verification

- `./equin test plugins/ids` — per shape: mint ↔ `is` ↔ `pattern` round-trip (1e5 mints, suffix length always 6), legacy bodies recognised (task ms/6, att s/4, `block-<ms>-<6>`, `<prefix>-<uuid>`, `claude-` aliases), prose boundaries (`id/logs`, `id.ts`, `/id` rejected; trailing period accepted), `parse()` upgrades bare uuid for `legacyBareUuid` kinds.
- `./equin check` — `ids:*`, `active-data:*`, `migrations-in-sync`, `migration-applies-clean` (dry-runs each rewrite against live main), `type-check` (branded columns).
- Rewrite migrations: `query_db` before/after on the worktree DB — `count(*) WHERE id NOT LIKE 'song-%'` = 0, child tables' FK columns match, no orphan soft refs; run the migration twice (idempotent).
- E2E: `./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts` on a conversation whose transcript mentions `task-…`, `att-…`, `song-…`, `proto-…` → each renders a chip and opens its pane; open an old `/sonata/song/<bare-uuid>` URL → resolves to the song.
