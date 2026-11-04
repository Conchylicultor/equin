import type { ReportRow } from "@plugins/reports/server";
import { PG_LOG_FILE } from "@plugins/database/plugins/embedded/server";
import { PGBOUNCER_LOG_FILE } from "@plugins/database/plugins/pgbouncer/server";
import { DB_POOLS_THROUGH_PGBOUNCER } from "@plugins/database/plugins/connection/core";
import {
  DB_ABANDON_CAP_KIND,
  DB_QUERY_DEADLINE_KIND,
  type DbAbandonCapPayload,
  type DbQueryDeadlinePayload,
} from "../../core";
import { isInTransaction } from "@plugins/database/plugins/connection/core";
import { formatDurationMs } from "../../shared/format-duration";
import { traceDetailRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";

// Everything kind-specific that can be said without the reports engine: the
// fingerprints, the one-line messages, and the investigation task bodies. Kept
// apart from the `ReportKind` wiring (kinds.ts) so it is testable without
// evaluating the reports plugin's server barrel.
//
// Every duration printed here arrives in the payload. Nothing spells "60s": the
// default bound and the scoped ones are the database plugin's, and a restated
// number would drift from them the first time either is edited.

/** Where the diagnosis of the 2026-09 stray closes lives, and how to hunt one. */
export const INCIDENT_DOC =
  "research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md";

/** Where the runbook for a database wedged by a lock chain lives. */
export const LOCK_CHAIN_DOC = "plugins/database/CLAUDE.md";

/** The longest stretch of a query label a task title carries. */
const TITLE_SQL_MAX = 80;

function clampOneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// --- db-query-deadline ------------------------------------------------------

/**
 * What one `db-query-deadline` row stands for: (pool, phase, origin) — or, for
 * a call with no origin (boot, migrations), (pool, phase, query label). NOT the trace trigger's
 * label, which is the coarser (pool, phase) — see the handler.
 *
 * By ORIGIN, not by statement: the question a lost call raises is "what was
 * this caller doing that the database never answered?", and one caller loses
 * calls under many labels — a query whose `in ($1, $2, …)` list varies is a new
 * label per arity, and a transaction's statements are several labels. Keyed by
 * label, the 2026-11-03 incident spread one cause over dozens of rows; keyed by
 * origin, each caller is one row whose count rises, and the latest lost
 * statement rides its payload.
 *
 * The pool and phase stay in it because they change the question. The same
 * caller on the app pool (through pgbouncer) and on a direct jobs pool is two
 * different sockets, two different logs to read; a caller failing to connect
 * is a different fact from one whose query went unanswered.
 */
export function queryDeadlineKey(
  d: Pick<DbQueryDeadlinePayload, "pool" | "phase" | "origin" | "sql">,
): string {
  const who = d.origin !== null ? `origin=${d.origin}` : `sql=${d.sql}`;
  return `${d.pool}:${d.phase}:${who}`;
}

export function queryDeadlineFingerprint(d: DbQueryDeadlinePayload): string {
  return `${DB_QUERY_DEADLINE_KIND}:${queryDeadlineKey(d)}`;
}

export function queryDeadlineMessage(d: DbQueryDeadlinePayload): string {
  return d.phase === "connect"
    ? `Opening a database connection (pool ${d.pool}) got no answer for ` +
        `${formatDurationMs(d.elapsedMs)} and was closed`
    : `A database query (pool ${d.pool}) got no answer for ` +
        `${formatDurationMs(d.elapsedMs)} and its connection was closed: ${d.sql}`;
}

/**
 * The log that saw the other end of this pool's socket. Only the app's lane
 * pools go through pgbouncer; every other pool dials Postgres's own socket
 * directly, so its client-side EOFs are in Postgres's log, not pgbouncer's.
 */
function serverLogFor(d: DbQueryDeadlinePayload): {
  file: string;
  signature: string;
} {
  return DB_POOLS_THROUGH_PGBOUNCER.has(d.pool)
    ? { file: PGBOUNCER_LOG_FILE, signature: "`client unexpected eof`" }
    : {
        file: PG_LOG_FILE,
        signature:
          "`unexpected EOF on client connection` or " +
          "`could not receive data from client`",
      };
}

export function renderQueryDeadlineTask(
  row: ReportRow,
  d: DbQueryDeadlinePayload,
): { title: string; description: string } {
  const log = serverLogFor(d);
  const lines: string[] = [];
  lines.push(
    `${d.phase === "connect" ? "Opening a database connection" : "A database query"} ` +
      `from this server got no answer for ${formatDurationMs(d.elapsedMs)}. ` +
      `The server stopped waiting at its ${formatDurationMs(d.deadlineMs)} ` +
      "deadline: the caller got a `QueryDeadlineExceededError` instead of a " +
      "result, and the connection was **closed**: taken out of its pool and " +
      "its socket shut, so Postgres ended its session — rolling back any " +
      "transaction it was in and releasing its locks — and pgbouncer freed " +
      "its slot.",
  );
  lines.push("");
  lines.push(
    "**Why this matters.** Before the deadline existed, a call like this " +
      "waited forever. On 2026-09-11 one sat inside a live-state flush, and " +
      "because flushes run one at a time, no database change reached any tab " +
      "for 25+ minutes while the health dot stayed green. On 2026-09-15 a job " +
      "waited 2.5 hours on one. The deadline turns that freeze into this report " +
      "and a pause of at most one deadline.",
  );
  lines.push("");
  lines.push(...evidenceLines(d));
  lines.push("**What to do:**");
  lines.push(
    d.phase === "connect"
      ? "1. Tell a lost connect from a refused or overloaded one. Check that " +
          "the database is up and not at its connection limit around the times " +
          "below; a database that answered nobody is an outage, not a stray close."
      : "1. Tell a lost query from a slow or blocked one. If Postgres had the " +
          "query (`pg_stat_activity` shows it running or waiting on a lock — " +
          "`pg_blocking_pids(pid)` names the blocker), it is not lost: find why " +
          "it waits. A transaction holding locks with calls queued behind it " +
          '(above) is a lock chain — see "Runbook: a database wedged by a lock chain" ' +
          `in \`${LOCK_CHAIN_DOC}\`. Boot DDL that legitimately waits on locks ` +
          "gets a longer bound with `withQueryDeadline`.",
  );
  lines.push(
    `2. Otherwise, look in \`${log.file}\` for a single ${log.signature} on ` +
      "this connection BEFORE the deadline fired, while the call was still " +
      "waiting. The deadline's own close leaves one at the instant it fires; " +
      "an earlier one means the socket was closed underneath the call by " +
      "something in this process — a stray close. A burst at the same " +
      "millisecond is just a restart.",
  );
  lines.push(
    "3. A stray close is a double close of a file descriptor. The 2026-09 ones " +
      "were Bun's own (oven-sh/bun#33828, fixed in 1.4.0; the `bun-runtime` " +
      "check re-proves it on every build), and app code holds every " +
      "descriptor as an `OwnedFd` (`packages/owned-fd`), whose second close " +
      "throws `FdAlreadyClosedError` naming the first — search the reports " +
      "for one. Otherwise hunt it with " +
      `"How to find it" in \`${INCIDENT_DOC}\`.`,
  );
  lines.push("");
  lines.push(
    `**Connection:** pool \`${d.pool}\`, ${d.phase === "connect" ? "while opening the connection" : "while running a query"}`,
  );
  if (d.phase === "query") lines.push(`**Query:** \`${d.sql}\``);
  lines.push(
    `**Waited:** ${formatDurationMs(d.elapsedMs)} ` +
      `(deadline ${formatDurationMs(d.deadlineMs)})`,
  );
  if (d.reason !== null) {
    lines.push(`**Longer deadline granted for:** ${d.reason}`);
  }
  lines.push(
    `**Ran under:** ${d.origin !== null ? `\`${d.origin}\`` : "unknown"}`,
  );
  lines.push("");
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  const title =
    d.phase === "connect"
      ? `[db] Opening a connection got no answer and was closed: pool ${d.pool}`
      : `[db] Unanswered query, connection closed (${d.pool}): ${clampOneLine(d.sql, TITLE_SQL_MAX)}`;
  return { title, description: lines.join("\n") };
}

/**
 * `value` as an inline code span. A label can hold backticks (a comment, a
 * quoted identifier in a hand-written statement): the fence is one longer than
 * the longest run inside, padded so an edge backtick does not merge into it.
 */
function code(value: string): string {
  const longest = Math.max(
    0,
    ...(value.match(/`+/g) ?? []).map((r) => r.length),
  );
  const fence = "`".repeat(longest + 1);
  return longest === 0
    ? `${fence}${value}${fence}`
    : `${fence} ${value} ${fence}`;
}

/** A short label for a transaction state, as the task body prints it. */
function txLabel(state: DbQueryDeadlinePayload["transaction"]): string {
  switch (state) {
    case "open":
      return "inside an open transaction";
    case "failed":
      return "inside a failed transaction";
    case "idle":
      return "outside any transaction";
    case null:
      return "not connected yet";
  }
}

/**
 * What the call was part of — read FIRST, because it usually says why the call
 * was lost before any stray-close hunt starts: a lost call inside a
 * transaction, others waiting behind it — that is a lock chain, not a
 * vanished socket.
 */
function evidenceLines(d: DbQueryDeadlinePayload): string[] {
  const lines: string[] = [
    "**What it was part of** (at the instant it was given up on):",
  ];
  if (d.phase === "query") {
    lines.push(
      d.transaction === null
        ? "- Its connection's transaction state: not recorded."
        : `- It was sent ${txLabel(d.transaction)}.` +
            (isInTransaction(d.transaction)
              ? " Closing the connection rolled that transaction back: its " +
                "work is lost, and the caller saw the error."
              : ""),
    );
  }
  if (d.inFlightCount === null) {
    lines.push("- Other database calls waiting: not recorded.");
  } else if (d.inFlightCount === 0) {
    lines.push("- No other database call was waiting.");
  } else {
    const shown =
      d.inFlight.length < d.inFlightCount
        ? ` (the ${d.inFlight.length} oldest)`
        : "";
    lines.push(
      `- ${d.inFlightCount} other database call${d.inFlightCount === 1 ? " was" : "s were"} waiting${shown}:`,
    );
    for (const c of d.inFlight) {
      lines.push(
        `  - ${formatDurationMs(c.ageMs)} · pool \`${c.pool}\` · ` +
          `${c.origin !== null ? code(c.origin) : "unknown caller"} · ` +
          (c.phase === "connect"
            ? "opening a connection"
            : `${isInTransaction(c.transaction) ? "in a transaction · " : ""}` +
              code(clampOneLine(c.sql, TITLE_SQL_MAX))),
      );
    }
  }
  if (d.traceId !== null) {
    lines.push(
      `- Everything in flight then (spans, gates, Postgres contention): ` +
        `\`${traceDetailRoute.link(debugApp, { id: d.traceId })}\` (Debug → Slow Events).`,
    );
  }
  lines.push("");
  return lines;
}

// --- db-abandon-cap (RETIRED) -------------------------------------------------
//
// Nothing files this kind any more: until 2026-11-04 a lost connection was
// abandoned (never closed) into a hold set capped at 32, and this kind fired
// past the cap. Lost connections are closed now. Kept so existing rows still
// validate, render and can be investigated.

/** One rolling row per worktree: the state of the process as a whole. */
export function abandonCapFingerprint(): string {
  return DB_ABANDON_CAP_KIND;
}

export function renderAbandonCapTask(
  row: ReportRow,
  d: DbAbandonCapPayload,
): { title: string; description: string } {
  const lines: string[] = [];
  lines.push(
    `This server had abandoned ${d.abandoned} database connections — more ` +
      `than the ${d.cap} its hold set kept. Until 2026-11-04 a connection whose ` +
      "call missed its deadline was abandoned (taken out of its pool, never " +
      "closed), and each one kept its server session, its PgBouncer slot and " +
      "any transaction it was in, until the backend restarted.",
  );
  lines.push("");
  lines.push(
    "**This kind is retired.** Lost connections are closed now, so their " +
      "transactions are rolled back and their slots freed; nothing files this " +
      "report any more. If the backend that filed it has restarted since " +
      `(\`Last seen\` below), there is nothing left to do here; the \`${DB_QUERY_DEADLINE_KIND}\` ` +
      "reports beside it name the calls that were lost.",
  );
  lines.push("");
  lines.push(`**Abandoned:** ${d.abandoned}`);
  lines.push(`**Latest abandon:** pool \`${d.pool}\``);
  lines.push(`**Cap:** ${d.cap}`);
  lines.push(`**Occurrences:** ${row.count}`);
  lines.push(`**Worktree:** ${row.worktree}`);
  lines.push(`**First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`**Last seen:** ${row.lastSeenAt.toISOString()}`);
  return {
    title: `[db] ${d.abandoned} abandoned database connections — over the cap of ${d.cap}`,
    description: lines.join("\n"),
  };
}
