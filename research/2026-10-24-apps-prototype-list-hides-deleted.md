# `prototype list` hides deleted prototypes again

## Context

The tag-tree change (3264d002f1) moved a prototype's deleted-ness from the
host-global `_status/<id>.json` files into each instance's DB
(`apps/prototypes/state`, `prototype_state.deleted_at`). `./equin prototype list`
(`files/cli/list.ts`) runs with no backend and used to read `_status` to leave
deleted prototypes out and count them. It can no longer see deleted-ness, so it
lists them again. Agents use `prototype list` to find prototypes, so this is a
regression. (Main's DB holds a deleted row today.)

Two things block the obvious fix:

- `files` can't read `prototype_state` itself: it would name another plugin's
  table.
- `files` can't import `state`, because `state` already imports `files`
  (`protoIdKind`, `prototypeExists`). The plugin graph is a DAG.

So a verb that needs both "what is on disk" (`files`) and "what the user deleted"
(`state`) has to live in a plugin above both. The verb group `prototype` is one
declaration and can't be split across plugins, so the whole group moves.

## Design

### 1. `state/cli/` — the backend-less read of deleted-ness (new)

This copies the existing precedent: `tasks/task-track/cli` (`checkoutTrack`) is a
`cli/` barrel with no default export, so it is not a command. It runs a raw `pg`
query from a CLI process, and its table and column names are hand-spelled and
pinned to the drizzle table by a test.

- `state/cli/index.ts` exports `readDeletedPrototypes(namespace)` and the type
  `DeletedPrototypes`:
  - `{ kind: "read"; ids: ReadonlySet<string> }`, or
  - `{ kind: "unavailable"; reason: string }`.
- `state/cli/internal/deleted-prototypes.ts`:
  - `PROTOTYPE_STATE_TABLE = { name: "prototype_state", id: "id", deletedAt: "deleted_at" }`.
  - `pg` `Client` on database = the checkout's namespace. A database is named
    after its namespace (`admin/server` pool: `buildConnString(conn,
    runtimeNamespace())`; main's is `singularity`). Connection params come from
    `libpqEnv()` (`database/core`), with a 3 s connect timeout and a 5 s query
    timeout, like `checkoutTrack`.
  - Rows are parsed with `queryRows` (`database/plugins/sql-rows/core`).
  - It never throws for a DB it can't consult. These cases return
    `unavailable` with a reason:
    - Cannot connect.
    - The DB doesn't exist (`3D000`: the checkout was never built).
    - The table doesn't exist (`42P01`: the DB predates the migration).
  - Any other query error, and a row that fails to parse (`SqlRowError`),
    throws.
- `deleted-prototypes.test.ts` pins the names to `_prototypeState`
  (`getTableConfig`).
- `state/package.json` gains the `pg` dependency (as task-track's has).

Which DB: **the checkout's own**. That is the same instance whose gallery the
printed URL opens, so the terminal and that gallery agree. Main's checkout
reads main's DB, and a worktree reads its fork.

### 2. `files/cli/` stops being a command and becomes a machinery barrel

- `files/cli/index.ts` no longer default-exports the group. It re-exports the
  verb actions by name (`newPrototypeAction`, `prototypeOptionsAction`,
  `prototypeLogAction`, `checkpointPrototypeAction`, `restorePrototypeAction`)
  and `printPrototypeList`. The verb modules keep their bodies.
- `files/cli/list.ts` becomes `printPrototypeList(deleted)`. The parameter is a
  structural union of the same shape as `DeletedPrototypes`, so `files` names
  no plugin and no table: "deleted" is data handed to it.
  - `read`: leave those ids out, and print the old footer, `N deleted
    prototype(s) not shown (the gallery's Trash).` If every prototype is
    deleted, print only that line.
  - `unavailable`: list everything, then print one stderr line saying deleted
    prototypes are included and why (the reason). The answer stays useful and
    says what it couldn't know.

### 3. New sub-plugin `apps/prototypes/plugins/commands` owns the `prototype` group

- `commands/cli/index.ts` is the declaration, moved verbatim from `files`
  (names, flags, help text). Each leaf is
  `run: async () => ({ default: (await import("@plugins/…/files/cli")).<action> })`.
  The import is dynamic, so `cli:command-declarations-light` still sees only
  `defineCliCommand`. Generics stay pinned, so each action is still
  type-checked against its declaration.
- `list`'s leaf runs `commands/cli/list.ts`:
  `checkoutNamespace(await getWorktreeRoot())` → `readDeletedPrototypes(ns)`
  (state/cli) → `printPrototypeList(deleted)` (files/cli).
- `commands/package.json` has a description (it feeds the generated docs).
  There is a short `CLAUDE.md`.
- Dependency direction: `commands` → `files`, `state`. No cycle.

### 4. Docs

- `files/CLAUDE.md` § `./equin prototype`: the group is declared in
  `commands`; `files` supplies the bodies. Drop the "lists deleted prototypes
  too" note and replace it with the new behaviour.
- `state/CLAUDE.md`: replace the "does not read this state" bullet with the
  `cli/` read.
- `prototypes/CLAUDE.md`: add a `commands` bullet.
- Generated registries and docs come from `./equin build`.

## Verification

- `./equin test` on `state/cli` (the name pin) and on `files`.
- `./equin check` (boundaries, cycles, declarations-light, registry in sync).
- Run `./equin prototype list` in this worktree after `./equin build`. The
  fork carries main's deleted row, so that prototype must be absent and the
  footer must count it. Also check `--help` for the group.
- Run the `unavailable` path with an unreachable `PGPORT`: everything is listed,
  plus the stderr line.
