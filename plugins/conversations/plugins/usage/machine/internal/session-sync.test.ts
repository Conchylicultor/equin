/**
 * The ledger-only path (`session-sync.ts`) against a real Postgres: a session
 * no conversation owns is counted under `session:<id>` with its source row and
 * scan rows, an append adds only its delta, a session equin ever ran is left to
 * the conversation path, a conversation adopting a scanned session takes its
 * tokens over (in the ledger once), and a rewritten file recounts its source.
 *
 * Run: `./equin test plugins/conversations/plugins/usage`
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import {
  _attempts,
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import { _conversationSessions } from "@plugins/conversations/plugins/session-chain/server";
import { sessionLinkIdKind } from "@plugins/conversations/plugins/session-chain/core";
import { _claudeUsageHours } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import { sessionSpendSource } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import { ownerAccountId, syncSessionUsage } from "./session-sync";
import { writeUsage } from "./write";
import { keyTranscriptScans } from "./scan-keys";
import { _claudeTranscriptScans } from "../../server/internal/tables";

setDefaultTimeout(120_000);

let t: TestDb;
let projects: string;

beforeAll(async () => {
  t = await createTestDb({ prefix: "usage_session_test" });
  await runMigrations(t.db);
  projects = await mkdtemp(join(tmpdir(), "usage-sessions-"));
  await t.db.insert(_tasks).values({
    id: "task-s",
    clusterId: "task-s",
    title: "usage sessions",
    titleAuto: false,
    rank: "a0",
    mandateRef: "interactive",
    authorKind: "human",
  } as typeof _tasks.$inferInsert);
  await t.db.insert(_attempts).values({
    id: "att-s",
    taskId: "task-s",
    worktreePath: "/tmp/usage-sessions",
  } as typeof _attempts.$inferInsert);
  await t.db.insert(_conversations).values({
    id: "conv-s",
    attemptId: "att-s",
    title: null,
    status: "working",
    runtime: "sdk",
    model: FALLBACK_MODEL,
    kind: "user",
    launchCause: "direct",
  } as typeof _conversations.$inferInsert);
});

afterAll(async () => {
  await t.drop();
  await rm(projects, { recursive: true, force: true });
});

const line = (id: string, input: number, output: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-16T09:15:00.000Z",
    requestId: `req-${id}`,
    message: {
      id,
      model: "claude-test",
      usage: { input_tokens: input, output_tokens: output },
    },
  }) + "\n";

/** A fresh session's file (`<projects>/-Users-me-elsewhere/<uuid>.jsonl`). */
async function newSession(text: string): Promise<{ id: string; path: string }> {
  const id = randomUUID();
  const dir = join(projects, "-Users-me-elsewhere");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  await writeFile(path, text);
  return { id, path };
}

/** Input / output the ledger holds for `source`, every account and hour summed. */
async function ledgerOf(source: string) {
  const rows = await t.db
    .select()
    .from(_claudeUsageHours)
    .where(eq(_claudeUsageHours.source, source));
  return {
    input: rows.reduce((n, r) => n + r.inputBelow + r.inputAbove, 0),
    output: rows.reduce((n, r) => n + r.outputBelow + r.outputAbove, 0),
    accounts: [...new Set(rows.map((r) => r.accountId))],
  };
}

/** The source's `claude_usage_sources` rows (the table is the ledger's own; read by name). */
async function sourceRowsOf(source: string) {
  const { rows } = await t.db.execute<{
    project_dir: string | null;
    is_repo: boolean;
    title: string | null;
  }>(
    sql`select project_dir, is_repo, title from claude_usage_sources where source = ${source}`,
  );
  return rows;
}

const owner = (accountUuid: string) =>
  JSON.stringify({
    type: "session-owner",
    accountUuid,
    organizationUuid: "org",
    sessionId: "s",
  }) + "\n";

/** Input tokens the ledger holds for `source`, per account (zero accounts left out). */
async function ledgerByAccount(source: string) {
  const rows = await t.db
    .select()
    .from(_claudeUsageHours)
    .where(eq(_claudeUsageHours.source, source));
  const out: Record<string, number> = {};
  for (const r of rows)
    out[r.accountId] = (out[r.accountId] ?? 0) + r.inputBelow + r.inputAbove;
  for (const [k, v] of Object.entries(out)) if (v === 0) delete out[k];
  return out;
}

const scansOf = (source: string) =>
  t.db
    .select()
    .from(_claudeTranscriptScans)
    .where(eq(_claudeTranscriptScans.source, source));

describe("syncSessionUsage", () => {
  test("counts a session no conversation owns, its sub-agents included, under session:<id>", async () => {
    const s = await newSession(line("m1", 10, 5));
    const agentDir = join(s.path.slice(0, -".jsonl".length), "subagents");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "agent-a1.jsonl"), line("a1", 100, 50));

    await syncSessionUsage(t.db, s.id, s.path, "job");
    const source = sessionSpendSource(s.id);
    expect(await ledgerOf(source)).toEqual({
      input: 110,
      output: 55,
      accounts: ["unknown"],
    });
    expect((await scansOf(source)).map((r) => r.kind).sort()).toEqual([
      "session",
      "subagent",
    ]);
    // Stored by transcript key, never by the absolute path.
    expect((await scansOf(source)).map((r) => r.path).sort()).toEqual([
      `${s.id}.jsonl`,
      `${s.id}/subagents/agent-a1.jsonl`,
    ]);
    expect(await sourceRowsOf(source)).toEqual([
      { project_dir: "-Users-me-elsewhere", is_repo: false, title: null },
    ]);

    // An append adds only what it appended (a top-up of m1 and a new message).
    await appendFile(s.path, line("m1", 10, 9) + line("m2", 1, 1));
    await syncSessionUsage(t.db, s.id, s.path, "job");
    expect(await ledgerOf(source)).toMatchObject({ input: 111, output: 60 });
    // Nothing new, nothing filed.
    await syncSessionUsage(t.db, s.id, s.path, "job");
    expect(await ledgerOf(source)).toMatchObject({ input: 111, output: 60 });
  });

  test("a renamed project dir, or a row stored under its absolute path, continues from its offset", async () => {
    const s = await newSession(line("m1", 10, 5));
    const source = sessionSpendSource(s.id);
    await syncSessionUsage(t.db, s.id, s.path, "job");
    expect(await ledgerOf(source)).toMatchObject({ input: 10, output: 5 });

    // The project dir is renamed under the row: nothing is counted again.
    const movedDir = join(projects, "-Users-me-renamed");
    await mkdir(movedDir, { recursive: true });
    const moved = join(movedDir, `${s.id}.jsonl`);
    await rename(s.path, moved);
    await syncSessionUsage(t.db, s.id, moved, "job");
    expect(await ledgerOf(source)).toMatchObject({ input: 10, output: 5 });

    // A row an older backend stored under the absolute path: the next read
    // continues from its offset and writes the keyed row beside it (the
    // absolute one stays while that backend may still read it)…
    await t.db
      .update(_claudeTranscriptScans)
      .set({ path: s.path })
      .where(eq(_claudeTranscriptScans.source, source));
    await appendFile(moved, line("m2", 1, 1));
    await syncSessionUsage(t.db, s.id, moved, "job");
    expect(await ledgerOf(source)).toMatchObject({ input: 11, output: 6 });
    // …the next read takes the furthest of the two…
    await appendFile(moved, line("m3", 1, 1));
    await syncSessionUsage(t.db, s.id, moved, "job");
    expect(await ledgerOf(source)).toMatchObject({ input: 12, output: 7 });
    expect((await scansOf(source)).map((r) => r.path).sort()).toEqual(
      [s.path, `${s.id}.jsonl`].sort(),
    );
    // …and keying the table keeps that one, under its key.
    const furthest = (await scansOf(source)).find(
      (r) => r.path === `${s.id}.jsonl`,
    )!;
    await keyTranscriptScans(t.db);
    await keyTranscriptScans(t.db);
    expect(await scansOf(source)).toEqual([furthest]);
  });

  test("leaves a session equin ever ran to the conversation path — a deleted conversation's included", async () => {
    const s = await newSession(line("m1", 10, 5));
    await t.db.insert(_conversationSessions).values({
      id: sessionLinkIdKind.mint(),
      conversationId: "conv-gone",
      claudeSessionId: s.id,
    } as typeof _conversationSessions.$inferInsert);
    await syncSessionUsage(t.db, s.id, s.path, "job");
    expect(await ledgerOf(sessionSpendSource(s.id))).toMatchObject({
      input: 0,
      output: 0,
    });
    expect(await scansOf(sessionSpendSource(s.id))).toEqual([]);
  });

  test("a conversation adopting a scanned session takes its tokens over: counted once", async () => {
    const s = await newSession(line("m1", 10, 5));
    const source = sessionSpendSource(s.id);
    await syncSessionUsage(t.db, s.id, s.path, "job");
    expect(await ledgerOf(source)).toMatchObject({ input: 10, output: 5 });

    // The reconciler records the session for the conversation; its sync counts
    // the file from the start under conv: and drops the session's rows.
    await t.db.insert(_conversationSessions).values({
      id: sessionLinkIdKind.mint(),
      conversationId: "conv-s",
      claudeSessionId: s.id,
    } as typeof _conversationSessions.$inferInsert);
    await writeUsage(
      t.db,
      "conv-s",
      [],
      null,
      [
        {
          accountId: "unknown",
          hour: new Date("2026-11-16T09:00:00Z"),
          model: "claude-test",
          speed: "standard",
          tokens: {
            input: { below: 10, above: 0 },
            output: { below: 5, above: 0 },
            cacheRead: { below: 0, above: 0 },
            cacheCreate5m: { below: 0, above: 0 },
            cacheCreate1h: { below: 0, above: 0 },
          },
        },
      ],
      null,
      [source],
    );
    expect(await ledgerOf(source)).toMatchObject({ input: 0, output: 0 });
    expect(await scansOf(source)).toEqual([]);
    expect(await sourceRowsOf(source)).toEqual([]);
    expect(await ledgerOf("conv:conv-s")).toMatchObject({
      input: 10,
      output: 5,
    });

    // A later pass of the ledger-only path (a backfill job queued before the
    // adoption) sees the session as equin's and files nothing.
    await appendFile(s.path, line("m2", 1, 1));
    await syncSessionUsage(t.db, s.id, s.path, "job");
    expect(await ledgerOf(source)).toMatchObject({ input: 0, output: 0 });
  });

  test("a file rewritten shorter than it was read recounts the whole source", async () => {
    const s = await newSession(line("m1", 10, 5) + line("m2", 20, 5));
    const source = sessionSpendSource(s.id);
    await syncSessionUsage(t.db, s.id, s.path, "job");
    expect(await ledgerOf(source)).toMatchObject({ input: 30, output: 10 });
    await writeFile(s.path, line("m3", 7, 1));
    await syncSessionUsage(t.db, s.id, s.path, "job");
    expect(await ledgerOf(source)).toMatchObject({ input: 7, output: 1 });
  });

  test("files each entry under the login its session-owner record names; a sub-agent under its session's", async () => {
    const login = randomUUID();
    const s = await newSession(
      line("m0", 1, 0) + owner(login) + line("m1", 10, 5),
    );
    const agentDir = join(s.path.slice(0, -".jsonl".length), "subagents");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "agent-a1.jsonl"), line("a1", 100, 50));
    await syncSessionUsage(t.db, s.id, s.path, "live");
    const source = sessionSpendSource(s.id);
    expect(await ledgerByAccount(source)).toEqual({
      unknown: 1,
      [`claude-login:${login}`]: 110,
    });
  });

  test("rows from before owners were read are recounted whole under the owners, once", async () => {
    const login = randomUUID();
    const s = await newSession(owner(login) + line("m1", 10, 5));
    const source = sessionSpendSource(s.id);
    await syncSessionUsage(t.db, s.id, s.path, "job");
    // As an older backend left it: filed under a guess, its row untracked.
    await t.db
      .update(_claudeUsageHours)
      .set({ accountId: "acct-guess" })
      .where(eq(_claudeUsageHours.source, source));
    await t.db
      .update(_claudeTranscriptScans)
      .set({ owner: null, ownerTracked: false })
      .where(eq(_claudeTranscriptScans.source, source));

    await syncSessionUsage(t.db, s.id, s.path, "job");
    expect(await ledgerByAccount(source)).toEqual({
      [`claude-login:${login}`]: 10,
    });
    expect(await scansOf(source)).toMatchObject([
      { owner: login, ownerTracked: true },
    ]);
    // Once: the next pass reads nothing new and files nothing.
    await syncSessionUsage(t.db, s.id, s.path, "job");
    expect(await ledgerByAccount(source)).toEqual({
      [`claude-login:${login}`]: 10,
    });
  });

  test("an untracked source with a file gone keeps what it filed, and is tracked from then on", async () => {
    const s = await newSession(line("m1", 10, 5));
    const source = sessionSpendSource(s.id);
    await syncSessionUsage(t.db, s.id, s.path, "job");
    await t.db.insert(_claudeTranscriptScans).values({
      path: `${s.id}/subagents/agent-gone.jsonl`,
      source,
      kind: "subagent",
      offset: 10,
      tailHashes: [],
      ownerTracked: false,
    });
    await t.db
      .update(_claudeTranscriptScans)
      .set({ ownerTracked: false })
      .where(eq(_claudeTranscriptScans.source, source));

    await syncSessionUsage(t.db, s.id, s.path, "job");
    expect(await ledgerByAccount(source)).toEqual({ unknown: 10 });
    expect((await scansOf(source)).map((r) => r.ownerTracked)).toEqual([
      true,
      true,
    ]);
  });

  test("an owner is the system account when it is the computer's login now", () => {
    const login = { kind: "signed-in", accountUuid: "u-1" } as const;
    expect(ownerAccountId("u-1", login)).toBe("system");
    expect(ownerAccountId("u-2", login)).toBe("claude-login:u-2");
    expect(ownerAccountId("u-1", { kind: "none" })).toBe("claude-login:u-1");
    expect(ownerAccountId(null, login)).toBe("unknown");
  });
});
