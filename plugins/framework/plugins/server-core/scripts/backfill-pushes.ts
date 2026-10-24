#!/usr/bin/env bun
/**
 * One-time backfill: insert push records for commits that have a Singularity-Push
 * trailer but are missing Singularity-Conversation (SINGULARITY_CONVERSATION_ID was
 * unset at commit time, so the hook never wrote the trailer).
 *
 * Strategy: the local worktree directory is named after the conversation ID, and
 * its HEAD matches the rebased commit SHA on main. We iterate all worktrees, find
 * any whose HEAD appears in the git log of main without a Singularity-Conversation
 * trailer, and insert the missing push records.
 *
 * Usage (the namespace whose database to write is stated, never inherited):
 *   ./equin run scripts/backfill-pushes.ts --namespace singularity          # dry run
 *   ./equin run scripts/backfill-pushes.ts --namespace singularity --write  # apply
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";

const DRY_RUN = !process.argv.includes("--write");

// ── inline schema (avoid importing server internals) ─────────────────────────

const pushes = pgTable(
  "pushes",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id").notNull(),
    conversationId: text("conversation_id"),
    sha: text("sha").notNull(),
    pushId: text("push_id").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("pushes_sha_unique").on(t.sha),
    index("pushes_push_id_idx").on(t.pushId),
    index("pushes_attempt_id_idx").on(t.attemptId),
  ],
);

// ── helpers ───────────────────────────────────────────────────────────────────

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await spawnExpectOk([GIT, ...args], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return result.stdout.trim();
}

interface CommitInfo {
  sha: string;
  committedAt: Date;
  conversationId: string;
  pushId: string;
  subject: string;
}

async function getMainWorktree(): Promise<string> {
  const out = await git(["worktree", "list", "--porcelain"]);
  const match = out.match(/^worktree (.+)$/m);
  if (!match?.[1]) throw new Error("Cannot find main worktree");
  return match[1];
}

async function readAllCommits(cwd: string): Promise<CommitInfo[]> {
  const FORMAT =
    "%H%x00%cI%x00" +
    "%(trailers:key=Singularity-Conversation,valueonly,separator=%x00)%x00" +
    "%(trailers:key=Singularity-Push,valueonly,separator=%x00)%x00" +
    "%s%x00";
  const raw = await git(
    ["log", "--no-color", `--format=${FORMAT}`, "main"],
    cwd,
  );
  const records = raw.split("\0\n").filter((r) => r.length > 0);
  return records
    .map((record) => {
      const fields = record.split("\0");
      const [sha, cIso, convRaw, pushRaw, subject] = fields;
      return {
        sha: sha ?? "",
        committedAt: new Date(cIso ?? ""),
        conversationId: (convRaw ?? "").trim(),
        pushId: (pushRaw ?? "").trim(),
        subject: subject ?? "",
      };
    })
    .filter((c) => c.sha);
}

interface WorktreeEntry {
  conversationId: string;
  ts: number; // unix timestamp parsed from the conversation ID prefix
}

// Maps full commit SHA → list of worktrees at that HEAD.
// Multiple worktrees can share the same SHA (e.g. worktrees created after a commit
// landed on main will also start at that SHA). The caller resolves ambiguity by
// picking the entry whose timestamp best matches the commit timestamp.
async function buildWorktreeMap(
  cwd: string,
): Promise<Map<string, WorktreeEntry[]>> {
  const raw = await git(["worktree", "list", "--porcelain"], cwd);
  const map = new Map<string, WorktreeEntry[]>();
  const stanzas = raw.split("\n\n").filter(Boolean);
  for (const stanza of stanzas) {
    const headMatch = stanza.match(/^HEAD ([0-9a-f]+)$/m);
    const branchMatch = stanza.match(
      /^branch refs\/heads\/claude-web\/(claude-(\d+)[^)]*?)$/m,
    );
    if (!headMatch?.[1] || !branchMatch?.[1] || !branchMatch[2]) continue;
    const sha = headMatch[1];
    const conversationId = branchMatch[1];
    const ts = parseInt(branchMatch[2], 10);
    const list = map.get(sha) ?? [];
    list.push({ conversationId, ts });
    map.set(sha, list);
  }
  return map;
}

// Among candidates for a SHA, pick the worktree whose timestamp is the largest
// value that is still ≤ commitTs (i.e. the conversation existed before the commit).
// If all worktrees post-date the commit (shouldn't happen in practice), fall back
// to the one with the smallest timestamp.
function resolveConversation(
  entries: WorktreeEntry[],
  commitTs: number,
): string {
  const before = entries.filter((e) => e.ts <= commitTs);
  if (before.length > 0) {
    return before.reduce((a, b) => (b.ts > a.ts ? b : a)).conversationId;
  }
  return entries.reduce((a, b) => (b.ts < a.ts ? b : a)).conversationId;
}

// ── main ──────────────────────────────────────────────────────────────────────

function argNamespace(): string {
  const i = process.argv.indexOf("--namespace");
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (value === undefined || value.startsWith("-")) {
    console.error(
      "--namespace <ns> is required — it names the database this script writes to.",
    );
    process.exit(1);
  }
  return value;
}

const worktree = argNamespace();

import { readFileSync } from "node:fs";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { DATABASE_CONFIG_PATH } from "@plugins/database/core";

// Wedge-breaker for this script's local git reads (`log`, `rev-parse`,
// `worktree list`). One number for all of them: they are metadata reads that
// finish in milliseconds, and a minute is only ever reached by a wedge.
const GIT_TIMEOUT_MS = 60_000;

const dbConfigPath = DATABASE_CONFIG_PATH;
let host = "localhost",
  port = "5432",
  user = process.env.USER ?? "postgres";
try {
  const cfg = JSON.parse(readFileSync(dbConfigPath, "utf-8"));
  host = cfg.connection?.host ?? host;
  port = String(cfg.connection?.port ?? port);
  user = cfg.connection?.user ?? user;
  // eslint-disable-next-line promise-safety/no-bare-catch
} catch {}
host = process.env.PGHOST ?? host;
port = process.env.PGPORT ?? port;
user = process.env.PGUSER ?? user;
const connectionString = host.startsWith("/")
  ? `postgres://${user}@/${worktree}?host=${encodeURIComponent(host)}&port=${port}`
  : `postgres://${user}@${host}:${port}/${worktree}`;

console.log(`DB:   ${connectionString}`);
console.log(`Mode: ${DRY_RUN ? "DRY RUN (pass --write to apply)" : "WRITE"}\n`);

const pool = new Pool({ connectionString, max: 1 });
const db = drizzle(pool);

const mainCwd = await getMainWorktree();
console.log(`Main worktree: ${mainCwd}\n`);

const [allCommits, worktreeMap] = await Promise.all([
  readAllCommits(mainCwd),
  buildWorktreeMap(mainCwd),
]);

const missing = allCommits.filter((c) => c.pushId && !c.conversationId);

console.log(`Commits on main:          ${allCommits.length}`);
console.log(
  `  with both trailers:     ${allCommits.filter((c) => c.pushId && c.conversationId).length}`,
);
console.log(`  missing Conversation:   ${missing.length}`);
console.log(
  `  missing both (manual):  ${allCommits.filter((c) => !c.pushId && !c.conversationId).length}`,
);
console.log();

if (missing.length === 0) {
  console.log("Nothing to backfill.");
  await pool.end();
  process.exit(0);
}

const existing = await db.select({ sha: pushes.sha }).from(pushes);
const existingShas = new Set(existing.map((r) => r.sha));

type Row = typeof pushes.$inferInsert;
const rows: Row[] = [];
let skipped = 0;

console.log("Plan:\n");
for (const commit of missing) {
  const entries = worktreeMap.get(commit.sha);
  const conversationId = entries
    ? resolveConversation(
        entries,
        Math.floor(commit.committedAt.getTime() / 1000),
      )
    : undefined;
  if (!conversationId) {
    console.log(
      `  SKIP no-worktree-match  ${commit.sha.slice(0, 9)}  "${commit.subject}"`,
    );
    skipped++;
    continue;
  }
  if (existingShas.has(commit.sha)) {
    console.log(
      `  SKIP already-in-db      ${commit.sha.slice(0, 9)}  "${commit.subject}"`,
    );
    skipped++;
    continue;
  }
  rows.push({
    id: `${commit.pushId}:${commit.sha}`,
    attemptId: conversationId,
    conversationId,
    sha: commit.sha,
    pushId: commit.pushId,
    message: commit.subject,
    createdAt: commit.committedAt,
  });
  console.log(
    `  INSERT  ${commit.sha.slice(0, 9)}  conv=${conversationId}  push=${commit.pushId.slice(0, 8)}  "${commit.subject}"`,
  );
}

console.log(`\nSummary: ${rows.length} to insert, ${skipped} skipped`);

if (DRY_RUN) {
  console.log("\n[DRY RUN] No changes written. Re-run with --write to apply.");
} else if (rows.length > 0) {
  console.log("\nInserting...");
  const inserted = await db
    .insert(pushes)
    .values(rows)
    .onConflictDoNothing()
    .returning();
  console.log(`Done. ${inserted.length} row(s) inserted.`);
}

await pool.end();
