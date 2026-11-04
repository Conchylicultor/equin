# Database connection failures: a failure must clean up after itself, and say so

Status: incident fixed on main; first fix (awake-time deadline) and an interim
backstop landed with this doc; the rest is proposed tasks below.

## The incident (2026-11-03 → 04, main)

`http://equin.localhost:9000/home` sat on "Waiting for the server…" for about
five hours.

| Local time | Evidence | Meaning |
|---|---|---|
| 20:02:13 | `pg_stat_activity.xact_start` of pid 87346 | a `conversations.usage:sync` transaction opens (`plugins/conversations/plugins/usage/machine/internal/sync.ts`: upsert `conversation_usage_files`, then `conversations_ext_usage`) |
| 20:02:06 → 20:18:21 | gap in `health.jsonl` (a 10 s sampler) | the laptop sleeps |
| 20:18:21 | `db.jsonl`: `[deadline] … no reply in 578ms (bound 60000ms) origin=conversations.usage:sync sql=insert into "conversations_ext_usage"` | on wake the 60 s timer fires at once — `setTimeout` ran through the sleep, `performance.now()` did not, so 578 ms of awake time had passed. The upsert HAD completed on the server |
| 20:18:21 → | pid 87346 `idle in transaction`, `ClientRead` | the client was **abandoned** (never closed, never sent `ROLLBACK`): Postgres keeps the transaction and its row locks for as long as the backend process lives |
| 20:30 → 00:55 | 15 sessions `INSERT … waiting` on `transactionid`, each blocked by the previous | every later usage sync queues on those rows; each waiter's own deadline fires after 60 s, so each is abandoned too |
| ~00:55 | 1 idle + 15 waiting = 16 = pgbouncer `default_pool_size` | every pgbouncer server slot for main's database is held by a dead session; every query — `SELECT 1` included — queues in pgbouncer forever |

Freeing it: `pg_terminate_backend(87346)` only passed the lock to the next dead
session (it finished its INSERT and sat idle in transaction); terminating all 16
restored main at once.

Nothing alerted. Each deadline wrote one `db.jsonl` line and lit the health
dot's Database row for 10 minutes; nothing tracked what the abandoned
connections went on holding, and `application_name` was empty, so the blocker
could not be attributed from the database side.

## Why connections are abandoned

`plugins/database/plugins/connection/server/internal/abandon.ts`, from the
2026-09-11 incident (`research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md`):
some code in the backend closed a file descriptor it did not own; the number had
been reused by a pooled pg socket, which died underneath a query that then waited
forever. The response was the deadline (every call fails after 60 s) plus the
abandon rule: on a missed deadline the connection is NOT closed, because its fd
number might already belong to an innocent resource that closing would kill.

The rule's written cost — "one leaked server connection" for a call that was
merely slow — is wrong twice:

1. **Inside a transaction the leak holds row locks**, indefinitely.
2. **The leak holds a pgbouncer server slot**, indefinitely. The app drops the
   abandoned client from its pool and opens a replacement; pgbouncer still counts
   the old one. Sixteen abandons on one database take it down, locks or not.

And the rule is itself a workaround: the code doing the stray close was never
found ("not found yet", 09-11). Abandoning made that symptom survivable and left
the cause in place.

## The vision

**A failure either cannot happen, or is recovered with nothing left behind — and
is reported. Nothing is set aside silently.** In order of cost:

1. **A stray close is inexpressible.** No raw fd numbers in app code: every
   descriptor lives in an owned handle that closes exactly once; a second close
   throws and names its caller. A lint bans closing a bare number and passing
   numeric fds as spawn stdio (the 09-10 victim was `spawnCaptured`'s temp-file
   fds). With fds owned, the reason to abandon is gone.
2. **A lost call cleans up.** Deadline fires → close the connection. Postgres
   rolls the transaction back and releases its locks; pgbouncer frees the slot.
   The "abandoned connection" concept disappears. Until (1) lands, the interim
   form: close when the fd is provably still ours (device + inode recorded at
   connect), abandon only when it is not — in which case the original socket was
   already closed and the server already rolled back.
3. **Deadlines measure awake time.** A sleep is not a silent connection.
   (Landed: `armAwakeDeadline`, `connection/server/internal/awake-timer.ts`.)
4. **Every deadline miss is a report**, deduped by origin, carrying the SQL and
   what else was in flight — not a log line and a dot that fades.
5. **No idle window inside a transaction.** A transaction that is a few writes is
   ONE statement (a data-modifying CTE, or a database function), so the server
   never waits on the app while holding locks. A multi-step body may issue only
   database calls.
6. **Background work cannot starve the UI.** The app's interactive/background
   lanes extend to pgbouncer: separate server pools per lane, so leaked or
   blocked background connections cannot take the slots `/home` needs.
7. **The database names who blocks whom.** Every query carries its origin as a
   SQL comment; a scheduled watchdog (a `defineJob` schedule — Postgres has no
   change signal for lock waits) reports blocking chains and long-idle
   transactions by origin, whatever caused them.
8. **Health is the current state.** The Database row says "blocked now" while it
   is, instead of clearing 10 minutes after the last event.

## Landed with this doc

- **(3) Awake-time deadline.** `DbClient`'s `connect()` and `query()` deadlines
  re-arm for what remains of their bound by `performance.now()` when the timer
  fires early (`awake-timer.ts`, tested in `awake-timer.test.ts`).
- **Interim backstop: `IDLE_IN_TRANSACTION_TIMEOUT_MS` (5 min).** The desktop
  driver's `ready()` sets it as the database's `idle_in_transaction_session_timeout`,
  so Postgres ends a transaction an abandoned connection left open. This is a
  bound around our own design flaw, not a fix: it reaps each dead link of a chain
  after 5 min (a 16-link chain still costs ~80 min), and the reap is not reported.
  **Remove it when task 2 lands.**

## Proposed tasks

| # | Task | Vision | Notes |
|---|---|---|---|
| 1 | Deadline miss files a report (origin, SQL, in-flight trace), deduped by origin | 4 | connection plugin; `database/query-deadline` handles the sink |
| 2 | Find the stray fd close (09-11); owned fd handles + lint; then close lost connections instead of abandoning; remove the idle-in-transaction backstop | 1, 2 | connection plugin + `infra/spawn`; sequential after 1 (same files) |
| 3 | DB watchdog: origin-tagged queries, scheduled blocking-chain / idle-transaction report, Database health row shows current state | 7, 8 | independent |
| 4 | Separate pgbouncer pools per lane, app pool split to match, lane-capacity invariant end to end | 6 | independent; `database/pgbouncer`, `pg-driver.ts` |
| 5 | Usage sync writes in one statement; list other multi-round-trip background transactions | 5 | independent; `conversations/usage` |

Tasks 1–2 touch the same connection-plugin files and run one after the other;
3, 4 and 5 are independent of them and of each other.
