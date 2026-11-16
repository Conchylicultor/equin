import { sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "@plugins/database/server";
import { _claudeTranscriptScans } from "../../server/internal/tables";

// ─── Scan rows stored under an absolute path, keyed ──────────────────────────
//
// `claude_transcript_scans.path` stores a transcript's key
// (`transcript-key.ts`); rows written before held the absolute
// `~/.claude/projects/<dir>/…` path. This rewrites them, keeping per
// transcript the row read furthest (a tie: the one already keyed, then the
// lexically smaller path) — a second row of one transcript is one count
// continued under two spellings, so nothing is given back. The key in SQL:
// the path from its first session-id segment on, the same as `transcriptKey`
// (a key never starts with `/`; a path with no segment keeps itself).
//
// Run by `conversations.usage.scan-keys` once no older backend is connected
// (jobs.ts says why it is not a data migration). Idempotent.

const SESSION_TAIL =
  "/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\\.jsonl)?(/.*)?)$";

/** A path column's key, in SQL (`transcriptKey`). */
const keyOf = (col: SQL) =>
  sql`(CASE WHEN ${col} LIKE '/%' THEN coalesce(substring(${col} from ${SESSION_TAIL}), ${col}) ELSE ${col} END)`;

/**
 * Rewrite every scan row stored under an absolute path to its key. The table
 * is locked against writes for the transaction, so a scanner's keyed row
 * cannot land between the dedup and the rewrite.
 */
export async function keyTranscriptScans(exec: DbExecutor): Promise<void> {
  const t = _claudeTranscriptScans;
  const path = sql`${t.path}`;
  const kPath = sql.raw("k.path");
  const kOffset = sql.raw(`k."offset"`);
  await exec.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE ${t} IN SHARE ROW EXCLUSIVE MODE`);
    // A row another row of its transcript beats (read further; a tie: keyed,
    // then the lexically smaller path).
    await tx.delete(t).where(
      sql`EXISTS (SELECT 1 FROM ${t} k
         WHERE ${kPath} <> ${path}
           AND ${keyOf(kPath)} = ${keyOf(path)}
           AND (${kOffset} > ${t.offset}
             OR (${kOffset} = ${t.offset} AND ${kPath} NOT LIKE '/%' AND ${path} LIKE '/%')
             OR (${kOffset} = ${t.offset} AND (${kPath} LIKE '/%') = (${path} LIKE '/%') AND ${kPath} < ${path})))`,
    );
    await tx
      .update(t)
      .set({ path: sql`substring(${path} from ${SESSION_TAIL})` })
      .where(
        sql`${path} LIKE '/%' AND substring(${path} from ${SESSION_TAIL}) IS NOT NULL`,
      );
  });
}
