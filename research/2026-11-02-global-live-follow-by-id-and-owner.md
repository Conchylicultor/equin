# Resources track [12] session 4: the nine id/owner values follow collection tuples

Status: **plan approved** (2026-11-02). Implementation starts once session 3's composite-key commit is on
main (after the useLive cleanup lands); then rebase onto main.

**Decisions (supervisor, 2026-11-02).**
- Dependent follows are the primitive for **all nine** values. task-subject and task-source-url follow the task row by the id the first follow read; there are no partly-narrowed joins.
- Session 3's byte residual is not slimmed.
- The run-events bound is settled during implementation, and stated (`limit` or a written `unbounded` reason), never silent.
- This session pushes its own work once build, checks, tests and the before/after measurement are green.

## Context

Nine live values declare whole tables in `reads`. So a write to one of those tables recomputes every
subscribed tuple, even when the write is about another subject. Each one reads rows found by id or by
an owner key, so the narrowing has to come from the machinery sessions 1–3 built:

- `follows` of a lookup (`{ ids }`) or a scoped set (`{ where }`) (session 2, `2026-10-24-global-live-narrowed-reads.md`);
- `all: { by }` scoped sets over composite primary keys (session 3, `2026-11-02-global-live-composite-key-collections.md`).

There is no hand-written per-row filter.

### What sessions 1–3 can and cannot express

- A follow's tuple is a function of the follower's **params only**.
- A lookup collection may carry a lookup **join**. Its far side becomes a column-gated `full` route with no per-tuple match: a write to the gated columns of **any** far-side row reaches every tuple.
- A composite-key set **refuses joins** (session 3, *As landed*). Its `followable.rows` is `null`, so it is followed by scope only.

Three of the nine read a link or ledger table with a composite pk and then the rows it names. None of
them has a spelling today (see the per-value table).

## Per value

| value | reads today | follows (target, tuple) | new collection(s) | expressible with 1–3? |
|---|---|---|---|---|
| attachments.file | `attachments` by id | `attachmentFiles {ids:[id]}` | `attachmentFiles` lookup, pick = the full row with `diskPath` (this value already hands it out) | yes |
| history.version | `entity_versions` by id (+ source/entity check) | `historyVersionSnapshots {ids:[versionId]}`; the loader checks `sourceId`/`entityId` on the followed row → `missing` | lookup over `entity_versions`, pick incl. `snapshot` (the timeline must keep it out) | yes (brand-only id-kind, session 3) |
| deploy.server-ssh-key | `deploy_servers` by id | `serverSshPublicKeys {ids:[serverId]}` | lookup, pick = the columns `toSshKey` reads | yes (brand-only id-kind) |
| mail.message-body | `mail_messages` + `mail_attachments` by message id | `body: mailMessageBodies {ids}`, `atts: mailMessageAttachments {where:{messageId}}` | lookup over `mail_messages` (body columns only, so a sync touching labels/flags skips by column gate); scoped set over `mail_attachments` by `messageId` | yes |
| task-source-url | attempt → task (`description`) → `tasks_ext_source_url` | lookup over `attempts` with lookup joins `tasks.description` and `source_url.url` | `attemptSourceUrls` | **partly**: the joins' far sides are gated `full`. A `description` edit to **any** task reaches every tuple. Exact only with dependent follows (below). |
| task-subject | `tasks_ext_subject` by (kind, id) ⋈ `tasks.dropped_at` | scoped set over `tasks_ext_subject` by `(subjectKind, subjectId)`, lookup join `tasks.droppedAt` | `subjectLinks` | **partly**: a drop of any task reaches every tuple (rare, gated on `dropped_at`). Exact with dependent follows. |
| attachments.by-owner | owner's link table (pk `(ownerId, attachmentId)`) ⋈ `attachments` | `links: <link>Set {where:{ownerId}}` → `atts: attachmentFiles {ids: links.map(attachmentId)}` | one scoped set per registered link (minted by `defineLink`) | **no**: composite set, joins refused |
| events.run-events | run (exists) + `event_source_run_events` (pk `(runId, eventId)`) ⋈ `events` ⋈ `event_sources` | `run: eventSourceRuns {ids:[runId]}`, `links {where:{runId}}` → `events {ids}` → `sources {ids}` | scoped set over run-events; lookups over `events` and `event_sources` | **no**: composite set, joins refused |
| claude-cli.calls-for | calls by `correlationId`; **on the empty path only**, the whole ring's `count` / `min(created_at)` | `calls: {where:{correlationId}}` → when empty, the ring horizon | scoped set over `claude_cli_calls`; the horizon as a one-row table the recorder writes in the trim's transaction (a lookup) | **no**: the horizon is followed only when `calls` is empty |

## Design: dependent follows (the one new primitive)

```ts
follows: (follow) => ({
  links: follow(linksServed, ({ ownerId }) => ({ where: { ownerId } })),
  atts:  follow(attachmentFilesServed, (_p, { links }) => ({ ids: links.map((l) => l.attachmentId) })),
}),
```

- A follow's tuple function may take the rows of the follows **declared before it**. Order is the declaration order, which makes it a DAG by construction. Referencing a later follow is a tsc error: its type sees only the earlier names.
- The tuple function may return `null`, meaning "not followed this load". This is the follow form of session 3's `useLive(scoped, null)` skip. It is how claude-cli reads the horizon only when `calls` is empty, and how by-owner follows only the link table for its `ownerType`.
- **Compile.** A dependent follow's routes are the target collection's routes, like a static follow. Their per-tuple `use.match` is **data**: the ids or scope the last load computed. The follower's own reader still reads only through the compiled readers. A8 drift judging per `via` is unchanged.
- **Runtime: the one load-bearing change.** The tuple's match for a dependent follow is installed at the end of each flight, from the rows that flight read. The window to close: a change to a newly named row commits after the flight's watermark but routes before the new match is installed. Rule: while a tuple is in flight, a change on a **dependent** follow's tables routes to that tuple unconditionally. It is gated by columns, and it re-runs the tuple once after the flight: the same drain the runtime uses for changes during a flight. This is correct by construction and costs at most one extra load per overlap. Pin it with an oracle test (insert link + attachment in one tx; update attachment X during a flight that first names X).
- `whileFollowing` / `onReached` re-points still work. A dependent follow's rows are part of `followed`.
- With dependent follows, task-source-url and task-subject drop their far-side `full` routes. Each follows the task row by the id the first follow read. They become exact.

Rejected alternatives:

- **Joins on composite sets.** This would undo a session 3 decision, and the far side would still be a `full` route with no match.
- **A second whole-table `reads` for the claude-cli horizon.** The rule "a `reads` table also followed is refused" exists precisely to stop re-widening.
- **Splitting by-owner into one value per owner type.** It is registry-backed on purpose (`defineLink` needs no serve code). Instead `defineLink` mints the link's scoped set, and the value follows each registered link with a tuple that is `null` unless `ownerType` matches.

## Bounds

- Scoped sets must state a bound. Attachments per owner, attachments per message and calls per correlation id are small.
- `event_source_run_events` per run is bounded today by `RUN_EVENTS_LIMIT` on the join ordered by `events.starts_at`. The scoped set needs the same limit expressed on the set, or a written `unbounded` reason. **Decide when implementing.** A run writes its whole set once, so either way a write reaches only the held run.

## The byte residual from session 3 (keyed delta 15–30 % larger on 1–2-row scopes)

**Decision: do not slim it.** The cost is tens of bytes per write on scopes that hold one or two
rows. Loads (the actual cost) drop to 0 either way, and on a real-sized scope the delta already wins
(authors 12145 → 11194). This session's nine are **values**, so they ship `update` frames, and the
unchanged-object D8 suppression sends nothing for a recompute that changes nothing. The residual does
not apply to them. Revisit only if a scope that is small and written hot shows up in the slow-ops profile.

## Measurement (`plugins/network/plugins/live/e2e/narrowing.ts --suite by-id`)

Fixture endpoints in `debug/read-set` (narrowing fixture), one pair per value: 10 writes to **another
subject's** rows, then 10 writes to the **held subject's** rows. Record loads / frames / chars per key,
medians of 3, before (main + session 3, values unchanged) and after. Expected: unrelated 10 → 0
loads for all nine, held 10 → 10 with unchanged bytes (still `update` frames). Extra phases:

- task-source-url / task-subject: an unrelated task's `description` / `dropped_at` → 0 (only with dependent follows);
- mail-body: a label/flag write on the held message → 0 (column gate).

## Execution order (one session)

1. Rebase onto main once session 3 lands. Run the baseline with the suite added.
2. Dependent follows: types, compile, the in-flight rule in `resource-runtime`, and the oracle test.
3. Migrate the five static ones (file, history, ssh-key, mail-body), then the four dependent ones (source-url, subject, by-owner, run-events, calls-for). One commit each, with keys left unchanged (a value's wire shape does not change, so no `.v2` rename).
4. After numbers. *As landed* here; track page header + [12] session 4 checkbox; file the next main task only.

## As landed (2026-11-03)

Eight of the nine values follow collection tuples. attachments.by-owner is the next session (below).

**The primitive: dependent follows.**
- **Spelling.** `follow.from(deps, target, (subject, rows) => tuple | null)` (network/live `core/internal/follows.ts`).
  - `deps` are follows made before it, so the follows form a DAG by construction.
  - They are read first, and their rows are handed in under the aliases named.
  - A dependency that `follows` does not return, one follow under two names, or an empty `deps` is refused.
  - Any tuple function may answer `null`: that subject reads nothing of the follow.
- **Compile.** `followRead(followable, name, { loaded, of })` (query-resource).
  - A loaded follow's routes carry `via.loaded`.
  - Its `usesOf(params, loaded)` reads the tuple from what the follower tuple's last load noted.
  - The loader's follows read notes every dependent tuple (`FollowLoaded`) to the runtime.
- **Runtime.** `LoadRun.noteLoaded` and `loadBracket` in `timedLoad`.
  - Each tracked tuple keeps the note of its newest-started completed load.
  - `usesFor` routes a loaded route past its match (gate and static rows only) in two cases: before any note, and while a load of the tuple is in flight. The second case covers a load that may be naming a row a change already touched. That change re-runs the tuple once.
  - A load that fails, or completes noting nothing, drops the note: the routes are open until a load notes again. (Review fix: a stale note would skip a row the tuple now names.) The note goes with the tuple (N→0).
- **Paged values take no dependent follow**: their pages are keyed external windows, which match per question.
- **One small compiler change.** An expression may be exactly one declared `serverOnly` column. A server field has no column override, so a follow target can now carry one (deploy's `ssh_public_key`).

**The values.** Each row lists its follow targets: new narrow collections that pick exactly what the loader reads.

| value | follows |
|---|---|
| attachments.file | `attachments.rows` by id. `attachments` became a `defineEntity` with the DDL unchanged. |
| history.version | `history.version-snapshots` by id. The (source, entity) pair is checked on the row, else `missing`. |
| deploy.server-ssh-key | `deploy.server-ssh-public-keys` by id (`ssh_public_key`, a server field) |
| mail.message-body | `mail.message-bodies` by id (body columns only), and `mail.message-attachments` scoped by `messageId` |
| task-source-url | `attempt-tasks` by id, then `task-source-urls` and `task-descriptions` by the task id it names (dependent) |
| task-subject | `task-subject-links` scoped by `(subjectKind, subjectId)`, then `task-dropped-states` by the linked task ids (dependent) |
| events.run-events | the run (`events.source-runs:rows`), `events.run-event-links` (scoped by `runId` over the composite key), then `events.run-event-rows` by the event ids and `events.sources.all:rows` by their sources (dependent). `firstSeenAt` / `lastSeenAt` are left out, so a run re-stamping every event it sees reaches no reader. |
| claude-cli.calls-for | `claude-cli-calls-by-record` scoped by `correlationId`. Then, only while the record has no calls and the reader gave `occurredAt`, the ring horizon `claude-cli-call-horizon` (dependent; `null` otherwise). |

**Decisions.**
- **The run-events bound** is stated on the run's set: `all: { max: 500 }` (`RUN_EVENT_LINKS_MAX`; 89 at most on main). Past it the read fails loudly instead of dropping rows. The value still shows the first `RUN_EVENTS_LIMIT` (200) by start.
- **The ring horizon** is a new one-row table, `claude_cli_call_horizon`, holding the log's size and its oldest call.
  - The recorder rewrites it in one transaction with its insert and trim, which now share that transaction.
  - It is seeded `onReady`, and excluded from forks like the log.
  - Reason: the `none` / `not-retained` verdict is inherently ring-wide, so it needs a row to follow. Only a record with no calls follows it.
- **task-subject's links are ordered by task id**: the extension shape's row carries no timestamp. A launch reuses a subject's live task, so the order only breaks a tie (the last by id wins; stamped ids sort by mint time).
- **The byte residual from session 3 was not slimmed** (see above).

**attachments.by-owner (next session).** Plan (A), approved:
- Each owner declares its link collection in its own `core/`, and contributes `{ ownerType, served }` through a generic `Attachments.Link` server contribution. The value names no owner.
- `defineLink` becomes `defineEntity` over the same ref.
- The value's `follows` are built from the contributions at `bindDeferredResources`, which needs `follows` evaluated lazily.
- It touches the six owner plugins.

### Numbers (`narrowing.ts --suite byid`, medians of 3 runs, 10 writes per phase)

Baseline: this branch with the six measured values' `serveValue` swapped back to their whole-table `reads`; the new collections were served. It was built and measured, then restored. After: the final build. The fixture creates and deletes every row it writes (debug read-set's narrowing fixture, new `create-fixture-row` / `write-fixture-row` / `delete-fixture-rows` actions).

| phase (10 writes) | key | loads before → after | frames before → after | chars before → after |
|---|---|---|---|---|
| ssh key, another server | deploy.server-ssh-key | 10 → **0** | 0 → 0 | 0 → 0 |
| snapshot, another entity's version | history.version | 10 → **0** | 0 → 0 | 0 → 0 |
| filename, another attachment | attachments.file | 10 → **0** | 0 → 0 | 0 → 0 |
| call recorded for another record | claude-cli.calls-for | 10 → **0** | 0 → 0 | 0 → 0 |
| link about another subject | task-subject.by-subject | 10 → **0** | 0 → 0 | 0 → 0 |
| source url of another task | task-source-url.by-attempt | 10 → **0** | 0 → 0 | 0 → 0 |
| the held server's key | deploy.server-ssh-key | 10 → 10 | 0 → 0 (no private key: `null` both ways) | 0 → 0 |
| the held version | history.version | 10 → 10 | update×10 → update×10 | 6279 → 6278 |
| the held attachment | attachments.file | 10 → 10 | update×10 → update×10 | 4729 → 4729 |
| a call for the held record | claude-cli.calls-for | 10 → 10 | update×10 → update×10 | 22686 → 22683 |
| the held subject's link | task-subject.by-subject | 10 → 10 | update×10 → update×10 | 3411 → 3410 |
| the held task's url | task-source-url.by-attempt | 10 → 10 | update×10 → update×10 | 3018 → 3018 |

- **Unrelated writes no longer reach the values: 10 → 0 loads, 0 frames.** `routeDrifted` was empty throughout.
- **A related write is one load either way, with the same bytes.** These are values, so they ship `update` frames, and session 3's keyed-delta residual does not apply.
- **Not measured:** mail.message-body and events.run-events. A fixture for their foreign-key chains (an account / thread / message; a source / run / event / link) was out of scope for the suite. Their routing is the same machinery the six exercise: a lookup by id, a scoped set, and dependent lookups. It is pinned by the unit suites.

## Session 5 — attachments.by-owner (as landed, 2026-11-03)

Plan (A), as approved. The ninth value follows collection tuples; it names no owner.

- **`followsAtBind(follows)`** (network/live core): a value's `follows` built at `bindDeferredResources`, from contributions collected by then. `followsOf` returns a lazy `CompiledFollows` (`atBind: true`) whose `list` / `dependent` / `read` compile on first use. `followsDeferred` answers `true` without compiling, so the value registers deferred. The loader no longer asks `dependent` at serve time: it always hands the note, and `read` calls it only when a follow is dependent. Refused on a paged value.
- **`Attachments.Link({ link, served })`**: the generic owner contribution. `ownerType` is read off the link handle (`defineLink`'s owner table name), never restated.
- **The six owners** (tasks, conversations: tasks-core; page_blocks: page/attachment-block; sonata_songs: sonata/library; agents; mail_drafts: mail-core) each declare in their own `core/` the link entity `entityRef("<owner>_attachments", attachmentLinkFields)` and a scoped set over it: `all: { by: ["ownerId"], orderBy: createdAt, max: ATTACHMENT_LINKS_MAX }`, `compositeKey(["ownerId","attachmentId"])`. Each serves it in `server/internal/attachment-links.ts` and contributes it there.
  - The key is a `liveCollection("…")` literal per owner, not a factory, so the resource scanners see it.
- **`defineLink(ownerTable, linkRef)`** is `defineEntity` over the ref, and refuses a ref not named `<owner>_attachments`. The DDL is unchanged: the build generated no migration. `list()` and the `getLink` map are deleted (by-owner was their only reader). The `defineLink` registry stays for the orphan sweep.
- **by-owner**: one follow `link:<ownerType>` per contribution. Its tuple is `{ where: { ownerId: id } }` for its own owner type and `null` otherwise. Then `attachments`, a `follow.from` over every link follow onto `attachments.rows` by the ids the sets name. The answer is in link order (`createdAt`, then id).
  - **Unknown owner type**: refused `unknown-owner-type`.
  - **Linked but not contributed** (`defineLink` ran, no `Attachments.Link`): a loud loader error, reported.
  - **Why the check is at read and not at bind**: a process may load an owner's tables without its plugin. The bun test runner does, and the bind check broke `serve-collection-exposed.test.ts`. With no contribution at all, `attachments` is a plain follow answering `null`.
- **Bound**: 500 links per owner, loud past it. The most on main is 25 (one conversation's pasted images).

### Numbers (`narrowing.ts --suite byid`, medians of 3, 10 writes per phase)

Baseline: this branch with by-owner's serve swapped back to the old whole-table `reads` (the attachments table plus every link table) and a join loader; the link collections were served. It was built and measured, then restored. Fixture: two fixture tasks, each linking its own fixture attachment. The new `write-fixture-row` target `task-attachment-link` toggles a third attachment's link on a task.

| phase (10 writes) | loads before → after | frames before → after | chars before → after |
|---|---|---|---|
| filename of another task's attachment | 10 → **0** | 0 → 0 | 0 → 0 |
| link toggled on another task | 10 → **0** | 0 → 0 | 0 → 0 |
| filename of the held task's attachment | 10 → 10 | update×10 → update×10 | 4228 → 4224 |
| link toggled on the held task | 10 → 10 | update×10 → update×10 | 5021 → 5021 |

- Every other phase stays at 0 loads both ways, and `routeDrifted` is empty throughout.
- The chars differ by a few bytes because the fixture ids are random per run.
- The other six values' numbers are unchanged from session 4.
- **Not measured**: mail.message-body and events.run-events. A fixture for their foreign-key chains is still not cheap (an account, thread and message for one; a source, run, event and link for the other).
