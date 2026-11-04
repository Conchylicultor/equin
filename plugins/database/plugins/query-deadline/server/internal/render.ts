import type { ReportRow } from "@plugins/reports/server";
import { PG_LOG_FILE } from "@plugins/database/plugins/embedded/server";
import { PGBOUNCER_LOG_FILE } from "@plugins/database/plugins/pgbouncer/server";
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

/** Where the diagnosis of the only known cause lives. */
export const INCIDENT_DOC =
  "research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md";

/** The runbook for a database wedged by a transaction an abandon left open. */
export const LOCK_CHAIN_DOC =
  "research/2026-11-04-global-db-connection-failure-vision.md";

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
        `${formatDurationMs(d.elapsedMs)} and was abandoned`
    : `A database query (pool ${d.pool}) got no answer for ` +
        `${formatDurationMs(d.elapsedMs)} and was abandoned: ${d.sql}`;
}

/**
 * The log that saw the other end of this pool's socket. Only the app pool goes
 * through pgbouncer; every other pool dials Postgres's own socket directly, so
 * its client-side EOFs are in Postgres's log, not pgbouncer's.
 */
function serverLogFor(d: DbQueryDeadlinePayload): {
  file: string;
  signature: string;
  leak: string;
} {
  return d.pool === "app"
    ? {
        file: PGBOUNCER_LOG_FILE,
        signature: "`client unexpected eof`",
        leak: "one leaked pgbouncer client connection",
      }
    : {
        file: PG_LOG_FILE,
        signature:
          "`unexpected EOF on client connection` or " +
          "`could not receive data from client`",
        leak: "one leaked Postgres connection",
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
      "result, and the connection was **abandoned** — taken out of its pool, " +
      "but deliberately not closed.",
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
  lines.push(
    "**Why abandoned, not closed.** The known way to get here is a " +
      "socket whose file handle was closed underneath a running call by other " +
      "code in the same process. `pg` gets no event, and Postgres never sees " +
      "the call. By the time the deadline fires, that handle number may " +
      "already belong to something else, so closing it would kill an innocent " +
      `resource. The cost of abandoning is ${log.leak} until the backend restarts.`,
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
          "it waits. A transaction left open by an earlier abandon, with calls " +
          "queued behind it (above), is a lock chain — see the runbook in " +
          `\`${LOCK_CHAIN_DOC}\`. Boot DDL that legitimately waits on locks ` +
          "gets a longer bound with `withQueryDeadline`.",
  );
  lines.push(
    `2. Otherwise, look in \`${log.file}\` around the ` +
      `first and last seen times below for a single, mid-life ${log.signature} ` +
      "on a young socket. That is the signature of a " +
      "stray close. A burst at the same millisecond is just a restart.",
  );
  lines.push(
    `3. Follow "How to find it" in \`${INCIDENT_DOC}\` to hunt the code that ` +
      "closes a file handle it does not own. Each report is another victim " +
      "sighting to add to its table.",
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
      ? `[db] Opening a connection got no answer and was abandoned: pool ${d.pool}`
      : `[db] Query got no answer and was abandoned (${d.pool}): ${clampOneLine(d.sql, TITLE_SQL_MAX)}`;
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
 * transaction, others waiting behind it, abandoned connections still holding
 * transactions open — that is a lock chain, not a vanished socket.
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
              ? " Abandoned, that connection is never rolled back: if Postgres " +
                "has the statement, the transaction and every row lock it took stay " +
                "open, and later writers to those rows queue behind it."
              : ""),
    );
  }
  if (d.abandoned !== null) {
    lines.push(
      `- Connections this process has abandoned since it started: ${d.abandoned.total}. ` +
        `Of the ${d.abandoned.held} it holds, ${d.abandoned.inTransaction} ` +
        "were left inside a transaction" +
        (d.abandoned.total > d.abandoned.held
          ? " (the rest are past the hold's cap, their state unknown)."
          : "."),
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

// --- db-abandon-cap ---------------------------------------------------------

/**
 * One rolling row per worktree (the reports unique index is
 * `(fingerprint, worktree)`). What is reported is the state of this process as
 * a whole, and the upsert refreshes `data` on every occurrence, so the row
 * always shows the latest count.
 *
 * The pool is NOT in the fingerprint. The hold set and its cap are process-wide,
 * shared by every pool, so "past the cap" is one fact about the process; a row
 * per pool would split one count across rows that each show the same total.
 * The payload's `pool` names the connection whose abandon crossed it most
 * recently, and the per-pool breakdown is the `db-query-deadline` rows.
 */
export function abandonCapFingerprint(): string {
  return DB_ABANDON_CAP_KIND;
}

export function abandonCapMessage(d: DbAbandonCapPayload): string {
  return (
    `${d.abandoned} database connections have been abandoned since the server ` +
    `started — more than the ${d.cap} it is built to hold (latest: pool ${d.pool})`
  );
}

export function renderAbandonCapTask(
  row: ReportRow,
  d: DbAbandonCapPayload,
): { title: string; description: string } {
  const lines: string[] = [];
  lines.push(
    `This server has abandoned ${d.abandoned} database connections since it ` +
      `started. The database plugin holds on to at most ${d.cap} of them, and ` +
      "it files this report for every abandon past that.",
  );
  lines.push("");
  lines.push(
    "Each one is a connection whose query got no answer before its deadline " +
      `(the \`${DB_QUERY_DEADLINE_KIND}\` reports next to this one name the ` +
      "queries). The server keeps a reference to every abandoned connection on " +
      "purpose, so that nothing — garbage collection included — ever closes its " +
      "file handle later, when that number may belong to something else. Past " +
      "the cap a newly abandoned connection is still taken out of the pool, but " +
      "is no longer held, so garbage collection may close its handle — the very " +
      "stray close the hold set exists to prevent (see `abandonClient` in " +
      "`plugins/database/plugins/connection/server/internal/`).",
  );
  lines.push("");
  lines.push(
    "**Going past the cap means lost queries are not rare here.** Something " +
      "keeps closing sockets underneath the pool, or the database keeps not " +
      "answering. Each abandoned connection also leaks one pgbouncer client " +
      "connection (app pool) or Postgres connection (every other pool) until the " +
      "backend restarts.",
  );
  lines.push("");
  lines.push(
    `**What to do:** restart the backend to release the leaked connections, ` +
      `then treat the \`${DB_QUERY_DEADLINE_KIND}\` reports as a live incident: ` +
      `follow "How to find it" in \`${INCIDENT_DOC}\`.`,
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
