import { describe, expect, test } from "bun:test";
import type { ReportRow } from "@plugins/reports/server";
import type { DbQueryDeadlinePayload } from "../../core";
import { PG_LOG_FILE } from "@plugins/database/plugins/embedded/server";
import { PGBOUNCER_LOG_FILE } from "@plugins/database/plugins/pgbouncer/server";
import {
  INCIDENT_DOC,
  LOCK_CHAIN_DOC,
  renderAbandonCapTask,
  renderQueryDeadlineTask,
} from "./render";

function row(data: Record<string, unknown>): ReportRow {
  const at = new Date("2026-09-11T10:00:00.000Z");
  return {
    id: "rep-1",
    kind: "db-query-deadline",
    fingerprint: "fp",
    worktree: "att-x",
    source: "server-caught",
    message: "m",
    url: null,
    userAgent: null,
    data,
    count: 3,
    rateLimited: false,
    noise: false,
    staleOrigin: false,
    lastClientId: null,
    lastBuildId: null,
    taskId: null,
    firstSeenAt: at,
    lastSeenAt: at,
    createdAt: at,
    updatedAt: at,
  } as ReportRow;
}

const payload: DbQueryDeadlinePayload = {
  sql: "select count(*) from conversations_v",
  elapsedMs: 60_004,
  deadlineMs: 60_000,
  origin: "push conversations-gone-stats",
  pool: "jobs-enqueue",
  phase: "query",
  reason: null,
  transaction: null,
  inFlight: [],
  inFlightCount: null,
  traceId: null,
};

describe("renderQueryDeadlineTask", () => {
  test("leads with what the call was part of: transaction, waiters, trace", () => {
    const d: DbQueryDeadlinePayload = {
      ...payload,
      pool: "app",
      transaction: "open",
      inFlight: [
        {
          pool: "app",
          phase: "query",
          sql: 'select "a`b" from t',
          origin: "conversations.usage:sync",
          ageMs: 45_000,
          transaction: "open",
        },
        {
          pool: "jobs-runner",
          phase: "connect",
          sql: "[connect]",
          origin: null,
          ageMs: 2_000,
          transaction: null,
        },
      ],
      inFlightCount: 14,
      traceId: "trace-1",
    };
    const { description } = renderQueryDeadlineTask(row(d), d);
    expect(description).toContain("It was sent inside an open transaction.");
    expect(description).toContain("rolled that transaction back");
    expect(description).toContain(
      "14 other database calls were waiting (the 2 oldest):",
    );
    expect(description).toContain(
      '  - 45s · pool `app` · `conversations.usage:sync` · in a transaction · `` select "a`b" from t ``',
    );
    expect(description).toContain(
      "  - 2s · pool `jobs-runner` · unknown caller · opening a connection",
    );
    expect(description).toContain("trace-1");
    expect(description).toContain(LOCK_CHAIN_DOC);
    expect(description).toContain(
      '"Runbook: a database wedged by a lock chain"',
    );
    // The evidence comes before the stray-close hunt.
    expect(description.indexOf("What it was part of")).toBeLessThan(
      description.indexOf("**What to do:**"),
    );
  });

  test("an older row says the evidence was not recorded, never that none existed", () => {
    const { description } = renderQueryDeadlineTask(row(payload), payload);
    expect(description).toContain("transaction state: not recorded");
    expect(description).toContain(
      "Other database calls waiting: not recorded.",
    );
    expect(description).not.toContain("No other database call was waiting");
  });

  test("states the problem and points at the incident doc", () => {
    const { title, description } = renderQueryDeadlineTask(
      row(payload),
      payload,
    );
    expect(title).toBe(
      "[db] Unanswered query, connection closed (jobs-enqueue): select count(*) from conversations_v",
    );
    expect(description).toContain("got no answer for 60s");
    expect(description).toContain("**closed**");
    expect(description).toContain(INCIDENT_DOC);
    expect(description).toContain(
      "**Ran under:** `push conversations-gone-stats`",
    );
    expect(description).toContain(
      "**Connection:** pool `jobs-enqueue`, while running a query",
    );
    expect(description).toContain("**Occurrences:** 3");
    expect(description).toContain(
      "**Query:** `select count(*) from conversations_v`",
    );
    // A direct pool never passed through pgbouncer: its socket's other end is
    // Postgres, so that is the log to read.
    expect(description).toContain(PG_LOG_FILE);
    expect(description).not.toContain(PGBOUNCER_LOG_FILE);
    // No scope granted a longer bound, so no line claims one.
    expect(description).not.toContain("Longer deadline granted for");
  });

  test("points the app pool at the pgbouncer log", () => {
    const app = { ...payload, pool: "app" as const };
    const { description } = renderQueryDeadlineTask(row(app), app);
    expect(description).toContain(PGBOUNCER_LOG_FILE);
    expect(description).not.toContain(PG_LOG_FILE);
    expect(description).toContain("`client unexpected eof`");
  });

  test("names a scoped longer bound and an unknown origin", () => {
    const scoped = {
      ...payload,
      elapsedMs: 900_000,
      deadlineMs: 900_000,
      origin: null,
      pool: "app" as const,
      phase: "connect" as const,
      sql: "[connect]",
      reason: "migrations",
    };
    const { title, description } = renderQueryDeadlineTask(row(scoped), scoped);
    expect(title).toBe(
      "[db] Opening a connection got no answer and was closed: pool app",
    );
    expect(description).not.toContain("**Query:**");
    expect(description).toContain(
      "Opening a database connection from this server",
    );
    expect(description).toContain("**Waited:** 15 min (deadline 15 min)");
    expect(description).toContain(
      "**Longer deadline granted for:** migrations",
    );
    expect(description).toContain("**Ran under:** unknown");
    expect(description).toContain(
      "**Connection:** pool `app`, while opening the connection",
    );
  });

  test("clamps a long, multi-line query label to one short title line", () => {
    const long = { ...payload, sql: `select\n  ${"x, ".repeat(60)}y from t` };
    const { title } = renderQueryDeadlineTask(row(long), long);
    expect(title).not.toContain("\n");
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThan(140);
  });
});

describe("renderAbandonCapTask (retired kind)", () => {
  test("still renders an old row, and says the kind is retired", () => {
    const d = { pool: "app" as const, abandoned: 33, cap: 32 };
    const { title, description } = renderAbandonCapTask(row(d), d);
    expect(title).toBe(
      "[db] 33 abandoned database connections — over the cap of 32",
    );
    expect(description).toContain("**Latest abandon:** pool `app`");
    expect(description).toContain("This kind is retired");
  });
});
