import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { stat } from "@plugins/packages/plugins/timed-fs/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { resolveTranscriptPathsOf } from "@plugins/conversations/plugins/transcript-watcher/server";
import {
  followedTranscriptChain,
  transcriptChainFollows,
} from "@plugins/conversations/plugins/transcript-source/server";
import {
  listSubagentEntries,
  subagentDirOf,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/machine";
import { conversationSpendSource } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import {
  _claudeModelRates,
  _claudePriceVersions,
  claudeSpendHoursView,
  priceWithRates,
  ratesInForceAt,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { conversationCostAt } from "../../core";
import { conversationUsageByIdServed } from "../../server/internal/served";
import { foldStretch, usageLineOf, type UsageLine } from "./cost-stretch";

// ─── What this is ──────────────────────────────────────────────────────────────
//
// The cost of a conversation by an instant (`conversationCostAt`): the
// transcript's cost stat reads it while the reader is scrolled back.
//
//   cost(at) = the priced ledger's hours before hour(at)      (the one pricing
//            + the stretch [hour(at), at] of the transcripts,   function, read)
//              folded with the ledger's fold and priced with
//              the rates in force at hour(at)
//
// The ledger is per hour, so only the stretch of one hour is read from disk —
// and that stretch is what the sync files into the ledger for that hour, line
// by line, so the reading walks smoothly up to the totals. Sub-agents' lines
// carry their own timestamps: their spend lands where it happened.
//
// Freshness: the value follows the conversation's usage row, which the
// database moves on every ledger write for this conversation (and on a price
// correction) — the sync writes after reading each append, so a line written
// before `at` reaches the value through it; and the transcript chain, which
// decides the files.

/** Each file's usage lines, read incrementally (an append costs its bytes). */
interface FileLines {
  /** Byte offset of the first line not read — always a line start. */
  offset: number;
  lines: UsageLine[];
}

/**
 * Per conversation, its files' usage lines — held for the conversations being
 * read, least recently read first, bounded: a reader scrolling one transcript
 * asks for many instants of one conversation, each a fold over memory.
 */
const held = new Map<string, Map<string, FileLines>>();
const HELD_MAX = 16;
const reads = createKeyedMutex();

function filesOf(conversationId: string): Map<string, FileLines> {
  const files = held.get(conversationId) ?? new Map<string, FileLines>();
  held.delete(conversationId);
  held.set(conversationId, files);
  for (const oldest of held.keys()) {
    if (held.size <= HELD_MAX) break;
    held.delete(oldest);
  }
  return files;
}

const NEWLINE = 0x0a;
/** One read's bytes: a first read of a 100 MB transcript holds a chunk, not the file. */
const READ_CHUNK = 8 * 1024 * 1024;
const decoder = new TextDecoder();

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

/** `prev` brought up to the complete lines `path` holds now (from 0 when it shrank). */
async function readLines(
  path: string,
  prev: FileLines | undefined,
): Promise<FileLines> {
  const size = await sizeOf(path);
  // Gone: what was read stays — the ledger keeps a vanished file's tokens too.
  if (size === null) return prev ?? { offset: 0, lines: [] };
  const from = prev && prev.offset <= size ? prev : { offset: 0, lines: [] };
  if (from.offset === size) return from;
  const lines = [...from.lines];
  const file = Bun.file(path);
  let offset = from.offset;
  let carry: Uint8Array = new Uint8Array(0);
  for (let at = from.offset; at < size;) {
    const to = Math.min(size, at + READ_CHUNK);
    const read = await file.slice(at, to).bytes();
    at = to;
    const bytes = carry.length === 0 ? read : concat(carry, read);
    const end = bytes.lastIndexOf(NEWLINE);
    if (end < 0) {
      carry = bytes;
      continue;
    }
    for (const text of decoder.decode(bytes.subarray(0, end)).split("\n")) {
      const line = usageLineOf(text);
      if (line) lines.push(line);
    }
    offset += end + 1;
    carry = bytes.subarray(end + 1);
  }
  return { offset, lines };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** The usage lines of `paths`, in order, each file brought up to date. */
async function usageLinesOf(
  conversationId: string,
  paths: readonly string[],
): Promise<UsageLine[][]> {
  return reads.run(conversationId, async () => {
    const files = filesOf(conversationId);
    const out: UsageLine[][] = [];
    for (const path of paths) {
      const next = await readLines(path, files.get(path));
      files.set(path, next);
      out.push(next.lines);
    }
    return out;
  });
}

const LedgerBeforeSchema = z.object({
  costUsd: z.number(),
  unpriced: z.array(z.string()),
});

/** The conversation's priced ledger hours before `hour`: their cost, and the models left unpriced. */
async function ledgerBefore(
  conversationId: string,
  hour: Date,
): Promise<z.infer<typeof LedgerBeforeSchema>> {
  const v = claudeSpendHoursView;
  const [row] = await executeRows(db, {
    label: "conversation cost before hour",
    query: sql`
      SELECT coalesce(sum(${v.costUsd}), 0)::float8 AS "costUsd",
             coalesce(array_agg(DISTINCT ${v.model})
                        FILTER (WHERE ${v.costUsd} IS NULL), '{}') AS unpriced
        FROM ${v}
       WHERE ${v.source} = ${conversationSpendSource(conversationId)}
         AND ${v.hour} < ${hour.toISOString()}::timestamptz`,
    row: LedgerBeforeSchema,
  });
  if (!row) throw new Error("an aggregate answered no row");
  return row;
}

/** The UTC hour `t` (epoch ms) falls in. */
function hourOf(t: number): Date {
  const d = new Date(t);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export const conversationCostAtServed = serveValue(conversationCostAt, {
  source: "external",
  changes: "notified",
  follows: (follow) => ({
    ...transcriptChainFollows(follow),
    // Moved by the database on every ledger write for this conversation and
    // on a price correction (`cost-triggers.ts`).
    usage: follow(conversationUsageByIdServed, ({ id }) => ({ ids: [id] })),
  }),
  reads: {
    tables: [],
    reason:
      "nothing read whole: the ledger and the rates reach it through the usage row it follows",
    notified: {
      relations: [
        claudeSpendHoursView,
        _claudeModelRates,
        _claudePriceVersions,
      ],
      reason:
        "the conversation's priced ledger hours and the rates in force: each write that moves them moves the conversation's usage row, which the value follows",
    },
  },
  loader: async ({ id, at }, { followed }) => {
    const until = Date.parse(at);
    const hour = hourOf(until);
    const sessionPaths = await resolveTranscriptPathsOf(
      followedTranscriptChain(followed),
    );
    const agents = await listSubagentEntries(sessionPaths.map(subagentDirOf));
    const [before, files, rates] = await Promise.all([
      ledgerBefore(id, hour),
      usageLinesOf(id, [
        ...sessionPaths,
        ...agents.map((a) => a.transcriptPath),
      ]),
      ratesInForceAt(db, hour),
    ]);
    let costUsd = before.costUsd;
    const unpriced = new Set(before.unpriced);
    for (const bucket of foldStretch(
      files,
      hour.getTime(),
      until,
    ).buckets.values()) {
      const cost = priceWithRates(rates, bucket);
      if (cost === null) unpriced.add(bucket.model);
      else costUsd += cost;
    }
    return { costUsd, unpricedModels: [...unpriced].sort() };
  },
});
