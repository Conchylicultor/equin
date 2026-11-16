/**
 * The ledger's one-shot history import (`history-import.ts`) against a real
 * Postgres: a conversation's pre-ledger count is filed up to its rounded file
 * buckets (what the sync filed since kept, under its account); an archived
 * transcript is imported only when no scanner covers it (gone from disk with
 * no scan row, or a deleted conversation's); a second run files nothing; and
 * what was imported survives a session's adoption by a conversation and a
 * whole-source recount, both of which take back only what was counted.
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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { writeAtomically } from "@plugins/database/server";
import {
  _attempts,
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import { _conversationSessions } from "@plugins/conversations/plugins/session-chain/server";
import { sessionLinkIdKind } from "@plugins/conversations/plugins/session-chain/core";
import {
  _claudeUsageHours,
  usageLedgerUpsert,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import {
  UNKNOWN_ACCOUNT,
  sessionSpendSource,
  type DayBucket,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import type { ArchiveEntry } from "./archive";
import {
  importUsageHistory,
  transcriptsOnDisk,
  type HistoryImportInputs,
} from "./history-import";
import { syncSessionUsage } from "./session-sync";
import { writeUsage } from "./write";
import {
  _claudeTranscriptScans,
  _claudeUsageHistoryImports,
  _conversationUsageFiles,
} from "../../server/internal/tables";

setDefaultTimeout(120_000);

let t: TestDb;
let projects: string;
const DIR = "-Users-me-elsewhere";

beforeAll(async () => {
  t = await createTestDb({ prefix: "usage_history_test" });
  await runMigrations(t.db);
  projects = await mkdtemp(join(tmpdir(), "usage-history-"));
  await mkdir(join(projects, DIR), { recursive: true });
  await t.db.insert(_tasks).values({
    id: "task-h",
    clusterId: "task-h",
    title: "usage history",
    titleAuto: false,
    rank: "a0",
    mandateRef: "interactive",
    authorKind: "human",
  } as typeof _tasks.$inferInsert);
  await t.db.insert(_attempts).values({
    id: "att-h",
    taskId: "task-h",
    worktreePath: "/tmp/usage-history",
  } as typeof _attempts.$inferInsert);
  await t.db.insert(_conversations).values({
    id: "conv-h",
    attemptId: "att-h",
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

const bucket = (date: string, input: number, hour?: number): DayBucket => ({
  date,
  ...(hour === undefined ? {} : { hour }),
  model: "claude-test",
  speed: "standard",
  input: { below: input, above: 0 },
  output: { below: 0, above: 0 },
  cacheRead: { below: 0, above: 0 },
  cacheCreate5m: { below: 0, above: 0 },
  cacheCreate1h: { below: 0, above: 0 },
});

const entry = (
  input: number,
  over: Partial<ArchiveEntry> = {},
): ArchiveEntry => ({
  partial: { dayBuckets: [bucket("2026-10-01", input)] },
  title: null,
  conversationId: null,
  isRepo: false,
  ...over,
});

const line = (id: string, input: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-16T09:15:00.000Z",
    requestId: `req-${id}`,
    message: {
      id,
      model: "claude-test",
      usage: { input_tokens: input, output_tokens: 0 },
    },
  }) + "\n";

const sessionPath = (id: string) => join(projects, DIR, `${id}.jsonl`);
const agentPath = (id: string, agent: string) =>
  join(projects, DIR, id, "subagents", `agent-${agent}.jsonl`);

const inputs = (archive: Map<string, ArchiveEntry>): HistoryImportInputs => ({
  archive,
  projectsDir: projects,
  onDisk: (keys) => transcriptsOnDisk(projects, keys),
  repoBasename: "my-repo",
});

/** Input the ledger holds for `source`, per origin, every account and hour summed. */
async function ledgerOf(source: string) {
  const rows = await t.db
    .select()
    .from(_claudeUsageHours)
    .where(eq(_claudeUsageHours.source, source));
  const sum = (origin: string) =>
    rows
      .filter((r) => r.origin === origin)
      .reduce((n, r) => n + r.inputBelow + r.inputAbove, 0);
  return { counted: sum("counted"), imported: sum("imported") };
}

async function sourceRowOf(source: string) {
  const { rows } = await t.db.execute<{
    project_dir: string | null;
    title: string | null;
  }>(
    sql`select project_dir, title from claude_usage_sources where source = ${source}`,
  );
  return rows;
}

// Sessions: A is the user's own (its file on disk, one sub-agent's gone); B
// ran conv-h (a gone sub-agent); D ran a conversation since deleted (its file
// still on disk); E is gone but already counted by a scan row.
const A = randomUUID();
const B = randomUUID();
const D = randomUUID();
const E = randomUUID();
const G = randomUUID();

describe("importUsageHistory", () => {
  test("files what no scanner covers, once", async () => {
    await writeFile(sessionPath(A), line("a1", 10));
    await writeFile(sessionPath(D), line("d1", 40));
    await t.db.insert(_conversationSessions).values([
      {
        id: sessionLinkIdKind.mint(),
        conversationId: "conv-h",
        claudeSessionId: B,
      },
      {
        id: sessionLinkIdKind.mint(),
        conversationId: "conv-dead",
        claudeSessionId: D,
      },
    ] as (typeof _conversationSessions.$inferInsert)[]);
    // conv-h's pre-ledger count: one file, 100.4 tokens (rounded: 100) — of
    // which the sync already filed 30 under the account it ran on.
    await t.db.insert(_conversationUsageFiles).values({
      conversationId: "conv-h",
      path: sessionPath(G),
      kind: "session",
      offset: 0,
      buckets: [bucket("2026-11-16", 100.4, 9)],
      tailHashes: [],
    });
    await writeAtomically(t.db, [
      usageLedgerUpsert(t.db, [
        {
          accountId: "max",
          hour: new Date("2026-11-16T09:00:00Z"),
          source: "conv:conv-h",
          model: "claude-test",
          speed: "standard",
          tokens: {
            input: { below: 30, above: 0 },
            output: { below: 0, above: 0 },
            cacheRead: { below: 0, above: 0 },
            cacheCreate5m: { below: 0, above: 0 },
            cacheCreate1h: { below: 0, above: 0 },
          },
        },
      ]),
    ]);
    await t.db.insert(_claudeTranscriptScans).values({
      path: sessionPath(E),
      source: sessionSpendSource(E),
      kind: "session",
      offset: 0,
      tailHashes: [],
    });

    const archive = new Map<string, ArchiveEntry>([
      // Gone, the user's session: imported under session:A.
      [agentPath(A, "x"), entry(7, { title: "mine" })],
      // On disk, the user's session: the session scanner's.
      [sessionPath(A), entry(10)],
      // Gone, a sub-agent of conv-h's chain: imported under conv:conv-h.
      [agentPath(B, "y"), entry(5)],
      // On disk, but its conversation is deleted: imported under conv:conv-dead.
      [sessionPath(D), entry(40, { conversationId: "conv-dead" })],
      // Gone but counted (a scan row; a conversation file row).
      [sessionPath(E), entry(1000)],
      [sessionPath(G), entry(1000)],
    ]);
    const first = await importUsageHistory(t.db, inputs(archive));
    expect(first).toMatchObject({
      kind: "imported",
      summary: {
        conversations: 1,
        archiveEntries: 3,
        archiveSkipped: 3,
      },
    });
    // The remainder beside what the sync filed, and the archived day: no
    // record of their account, so UNKNOWN_ACCOUNT.
    const convRows = await t.db
      .select({
        accountId: _claudeUsageHours.accountId,
        hour: _claudeUsageHours.hour,
        origin: _claudeUsageHours.origin,
        input: _claudeUsageHours.inputBelow,
      })
      .from(_claudeUsageHours)
      .where(eq(_claudeUsageHours.source, "conv:conv-h"))
      .orderBy(_claudeUsageHours.hour, _claudeUsageHours.origin);
    expect(convRows).toEqual([
      {
        accountId: UNKNOWN_ACCOUNT,
        hour: new Date("2026-10-01T00:00:00Z"),
        origin: "imported",
        input: 5,
      },
      {
        accountId: "max",
        hour: new Date("2026-11-16T09:00:00Z"),
        origin: "counted",
        input: 30,
      },
      {
        accountId: UNKNOWN_ACCOUNT,
        hour: new Date("2026-11-16T09:00:00Z"),
        origin: "imported",
        input: 70,
      },
    ]);
    expect(await ledgerOf(sessionSpendSource(A))).toEqual({
      counted: 0,
      imported: 7,
    });
    // 100 from its file rows (30 counted, 70 imported) + 5 archived.
    expect(await ledgerOf("conv:conv-h")).toEqual({
      counted: 30,
      imported: 75,
    });
    expect(await ledgerOf("conv:conv-dead")).toEqual({
      counted: 0,
      imported: 40,
    });
    expect(await ledgerOf(sessionSpendSource(E))).toEqual({
      counted: 0,
      imported: 0,
    });
    expect(await sourceRowOf(sessionSpendSource(A))).toEqual([
      { project_dir: DIR, title: "mine" },
    ]);

    // A second run files nothing.
    expect(await importUsageHistory(t.db, inputs(archive))).toEqual({
      kind: "already-imported",
    });
    expect(await ledgerOf("conv:conv-h")).toEqual({
      counted: 30,
      imported: 75,
    });
  });

  test("a recount and an adoption take back only what was counted", async () => {
    const source = sessionSpendSource(A);
    await syncSessionUsage(t.db, A, sessionPath(A), "job");
    expect(await ledgerOf(source)).toEqual({ counted: 10, imported: 7 });

    // Rewritten shorter: the whole source is recounted — its counted rows.
    await writeFile(sessionPath(A), line("a2", 3));
    await syncSessionUsage(t.db, A, sessionPath(A), "job");
    expect(await ledgerOf(source)).toEqual({ counted: 3, imported: 7 });

    // conv-h adopts session A: the counted rows go, the imported stay with
    // their source row.
    await writeUsage(t.db, "conv-h", [], null, [], null, [source]);
    expect(await ledgerOf(source)).toEqual({ counted: 0, imported: 7 });
    expect(await sourceRowOf(source)).toEqual([
      { project_dir: DIR, title: "mine" },
    ]);
  });

  // The data-root move renamed the project dirs under the archive and the
  // older rows: a transcript is matched by its session-relative path.
  const OLD_DIR = "-Users-me--oldroot-state-ws";
  const NEW_DIR = "-Users-me--newroot-state-ws";
  const at = (dir: string, id: string) => join(projects, dir, `${id}.jsonl`);
  const R1 = randomUUID();
  const R2 = randomUUID();
  const R3 = randomUUID();
  const R4 = randomUUID();

  /** A database without the first test's import: rows, record and state gone. */
  async function freshImport() {
    await t.db.delete(_claudeUsageHistoryImports);
    await t.db.delete(_claudeUsageHours);
    await t.db.delete(_conversationUsageFiles);
    await t.db.delete(_claudeTranscriptScans);
  }

  test("matches transcripts across a renamed project dir", async () => {
    await freshImport();
    await mkdir(join(projects, NEW_DIR), { recursive: true });
    // R1 is on disk under the new name only: the session scanner's.
    await writeFile(at(NEW_DIR, R1), line("r1", 1));
    // R2 was counted by conv-h under the new name (its file since gone),
    // day buckets: 11-15 and 11-14.
    await t.db.insert(_conversationUsageFiles).values({
      conversationId: "conv-h",
      path: at(NEW_DIR, R2),
      kind: "session",
      offset: 0,
      buckets: [bucket("2026-11-15", 50), bucket("2026-11-14", 20)],
      tailHashes: [],
    });
    // R3 was scanned under the new name.
    await t.db.insert(_claudeTranscriptScans).values({
      path: at(NEW_DIR, R3),
      source: sessionSpendSource(R3),
      kind: "session",
      offset: 0,
      tailHashes: [],
    });
    const archive = new Map<string, ArchiveEntry>([
      [at(OLD_DIR, R1), entry(1000)],
      [at(OLD_DIR, R2), entry(1000)],
      [at(OLD_DIR, R3), entry(1000)],
      // Gone under every name, counted by nothing: imported.
      [at(OLD_DIR, R4), entry(9)],
    ]);
    expect(await importUsageHistory(t.db, inputs(archive))).toMatchObject({
      kind: "imported",
      summary: { archiveEntries: 1, archiveSkipped: 3 },
    });
    for (const id of [R1, R3])
      expect(await ledgerOf(sessionSpendSource(id))).toEqual({
        counted: 0,
        imported: 0,
      });
    expect(await ledgerOf(sessionSpendSource(R4))).toEqual({
      counted: 0,
      imported: 9,
    });
    const convRows = await t.db
      .select({
        accountId: _claudeUsageHours.accountId,
        hour: _claudeUsageHours.hour,
        input: _claudeUsageHours.inputBelow,
      })
      .from(_claudeUsageHours)
      .where(eq(_claudeUsageHours.source, "conv:conv-h"))
      .orderBy(_claudeUsageHours.hour);
    expect(convRows).toEqual([
      {
        accountId: UNKNOWN_ACCOUNT,
        hour: new Date("2026-11-14T00:00:00Z"),
        input: 20,
      },
      {
        accountId: UNKNOWN_ACCOUNT,
        hour: new Date("2026-11-15T00:00:00Z"),
        input: 50,
      },
    ]);
  });

  test("refuses a conversation counting one transcript under two names", async () => {
    await freshImport();
    const R5 = randomUUID();
    await t.db.insert(_conversationUsageFiles).values(
      [OLD_DIR, NEW_DIR].map((dir) => ({
        conversationId: "conv-h",
        path: at(dir, R5),
        kind: "session" as const,
        offset: 0,
        buckets: [bucket("2026-11-15", 5)],
        tailHashes: [],
      })),
    );
    expect(importUsageHistory(t.db, inputs(new Map()))).rejects.toThrow(
      /counts one transcript twice/,
    );
  });
});
