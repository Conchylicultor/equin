import { and, eq, inArray, sql } from "drizzle-orm";
import type { AtomicWrite, DbExecutor } from "@plugins/database/server";
import {
  TOKEN_KINDS,
  TOKEN_TIERS,
  type SpendSource,
  type TokenKind,
  type TokenTier,
  type UsageOrigin,
  type UsageSpeed,
  type UsageTokens,
} from "../../core";
import { _claudeUsageHours, _claudeUsageSources } from "./tables";

/** Tokens to add to one account's hour, under what used them, per model and speed. */
export interface UsageLedgerRow {
  accountId: string;
  /** The UTC hour (`spendHourOf`); minutes and seconds must be zero. */
  hour: Date;
  source: SpendSource;
  /** The model string as observed. */
  model: string;
  speed: UsageSpeed;
  /** Whole-token deltas, each kind split at the tier — negative to take back. */
  tokens: UsageTokens;
}

/** A row's ledger key: the rows of one insert must not repeat it. */
const usageKey = (r: UsageLedgerRow): string =>
  `${r.accountId}\0${r.hour.toISOString()}\0${r.source}\0${r.model}\0${r.speed}`;

/** The ledger column each (kind, tier) count is stored in. */
const COLUMN = {
  input: { below: "inputBelow", above: "inputAbove" },
  output: { below: "outputBelow", above: "outputAbove" },
  cacheRead: { below: "cacheReadBelow", above: "cacheReadAbove" },
  cacheCreate5m: { below: "cacheCreate5mBelow", above: "cacheCreate5mAbove" },
  cacheCreate1h: { below: "cacheCreate1hBelow", above: "cacheCreate1hAbove" },
} as const satisfies Record<
  TokenKind,
  Record<TokenTier, keyof typeof _claudeUsageHours.$inferInsert>
>;

/**
 * The token-ledger write for `rows`: each row's counts ADDED to what its
 * (account, hour, source, model, speed) already holds — a negative count takes
 * tokens back. Rows sharing a key are summed first (one insert may not touch a
 * row twice), and a row that adds nothing is dropped. A builder, not a run —
 * an arm of the caller's `writeAtomically` group, or awaited in its
 * transaction — so the tokens land with the write that counted them. `null`
 * (no write) when there is nothing to add.
 *
 * Throws on an hour that is not on the hour, or a count that is not a whole
 * number (the columns are bigint; a writer rounds its buckets first).
 */
export function usageLedgerUpsert(
  exec: DbExecutor,
  rows: readonly UsageLedgerRow[],
): AtomicWrite {
  return ledgerAdd(exec, rows, "counted");
}

/**
 * The history import's write (conversations/usage's one-shot import): like
 * {@link usageLedgerUpsert}, under origin `imported` — rows no scanner's
 * take-back reaches (`usageLedgerRowsOf`, `usageLedgerDropSources`), because
 * they describe transcripts no scanner can read again.
 */
export function usageLedgerImport(
  exec: DbExecutor,
  rows: readonly UsageLedgerRow[],
): AtomicWrite {
  return ledgerAdd(exec, rows, "imported");
}

function ledgerAdd(
  exec: DbExecutor,
  rows: readonly UsageLedgerRow[],
  origin: UsageOrigin,
): AtomicWrite {
  const merged = new Map<string, UsageLedgerRow>();
  for (const row of rows) {
    if (row.hour.getTime() % 3_600_000 !== 0)
      throw new Error(
        `usage ledger row for ${row.accountId}/${row.source} is not on an hour: ${row.hour.toISOString()}`,
      );
    for (const kind of TOKEN_KINDS)
      for (const tier of TOKEN_TIERS)
        if (!Number.isSafeInteger(row.tokens[kind][tier]))
          throw new Error(
            `usage ledger row for ${row.accountId}/${row.source}/${row.model} has a non-whole ${kind}.${tier} count: ${row.tokens[kind][tier]}`,
          );
    const key = usageKey(row);
    const prev = merged.get(key);
    if (prev === undefined) {
      merged.set(key, { ...row, tokens: structuredClone(row.tokens) });
      continue;
    }
    for (const kind of TOKEN_KINDS)
      for (const tier of TOKEN_TIERS)
        prev.tokens[kind][tier] += row.tokens[kind][tier];
  }
  const values = [...merged.values()]
    .filter((r) =>
      TOKEN_KINDS.some((kind) =>
        TOKEN_TIERS.some((tier) => r.tokens[kind][tier] !== 0),
      ),
    )
    .map((r) => {
      const row: typeof _claudeUsageHours.$inferInsert = {
        accountId: r.accountId,
        hour: r.hour,
        source: r.source,
        model: r.model,
        speed: r.speed,
        origin,
      };
      for (const kind of TOKEN_KINDS)
        for (const tier of TOKEN_TIERS)
          row[COLUMN[kind][tier]] = r.tokens[kind][tier];
      return row;
    });
  if (values.length === 0) return null;
  const t = _claudeUsageHours;
  const added = (column: string) =>
    sql`${sql.identifier("claude_usage_hours")}.${sql.identifier(column)} + excluded.${sql.identifier(column)}`;
  return exec
    .insert(t)
    .values(values)
    .onConflictDoUpdate({
      target: [t.accountId, t.hour, t.source, t.model, t.speed, t.origin],
      set: {
        inputBelow: added("input_below"),
        inputAbove: added("input_above"),
        outputBelow: added("output_below"),
        outputAbove: added("output_above"),
        cacheReadBelow: added("cache_read_below"),
        cacheReadAbove: added("cache_read_above"),
        cacheCreate5mBelow: added("cache_create_5m_below"),
        cacheCreate5mAbove: added("cache_create_5m_above"),
        cacheCreate1hBelow: added("cache_create_1h_below"),
        cacheCreate1hAbove: added("cache_create_1h_above"),
      },
    });
}

/** What a writer knows about a source (see `claude_usage_sources`). */
export interface UsageSourceRow {
  source: SpendSource;
  projectDir: string | null;
  isRepo: boolean;
  title: string | null;
}

/**
 * The source-row write for `rows`: inserted, or merged into what the row
 * holds — a known project dir or title is never replaced by an unknown one,
 * and a source once equin's own stays so. A builder like `usageLedgerUpsert`;
 * `null` when there is nothing to write. Unchanged rows are not rewritten.
 */
export function usageSourcesUpsert(
  exec: DbExecutor,
  rows: readonly UsageSourceRow[],
): AtomicWrite {
  const merged = new Map<string, UsageSourceRow>();
  for (const row of rows) {
    const prev = merged.get(row.source);
    merged.set(
      row.source,
      prev === undefined
        ? row
        : {
            source: row.source,
            projectDir: row.projectDir ?? prev.projectDir,
            isRepo: row.isRepo || prev.isRepo,
            title: row.title ?? prev.title,
          },
    );
  }
  if (merged.size === 0) return null;
  const t = _claudeUsageSources;
  const next = {
    projectDir: sql`COALESCE(excluded.project_dir, ${t.projectDir})`,
    isRepo: sql`(${t.isRepo} OR excluded.is_repo)`,
    title: sql`COALESCE(excluded.title, ${t.title})`,
  };
  return exec
    .insert(t)
    .values([...merged.values()])
    .onConflictDoUpdate({
      target: t.source,
      set: next,
      setWhere: sql`(${t.projectDir}, ${t.isRepo}, ${t.title}) IS DISTINCT FROM (${next.projectDir}, ${next.isRepo}, ${next.title})`,
    });
}

/**
 * Every ledger row the writers COUNTED under `sources` (origin `counted`; the
 * history import's rows are never taken back), as rows `usageLedgerUpsert`
 * takes — one per (account, hour, source, model, speed). How a writer takes back what it filed
 * for a source it is about to recount whole (`negateUsage`), when what it
 * filed can no longer be told from what it read (a transcript rewritten
 * shorter than it was read).
 */
export async function usageLedgerRowsOf(
  exec: DbExecutor,
  sources: readonly SpendSource[],
): Promise<UsageLedgerRow[]> {
  if (sources.length === 0) return [];
  const t = _claudeUsageHours;
  const rows = await exec
    .select()
    .from(t)
    .where(and(inArray(t.source, [...sources]), eq(t.origin, "counted")));
  return rows.map((r) => {
    const tokens = {} as UsageTokens;
    for (const kind of TOKEN_KINDS) {
      tokens[kind] = { below: 0, above: 0 };
      for (const tier of TOKEN_TIERS)
        tokens[kind][tier] = r[COLUMN[kind][tier]];
    }
    return {
      accountId: r.accountId,
      hour: r.hour,
      // Read back from the key it was written under.
      source: r.source as SpendSource,
      model: r.model,
      speed: r.speed,
      tokens,
    };
  });
}

/** `rows` with every count negated: added, they take the rows back. */
export function negateUsage(rows: readonly UsageLedgerRow[]): UsageLedgerRow[] {
  return rows.map((r) => {
    const tokens = {} as UsageTokens;
    for (const kind of TOKEN_KINDS)
      tokens[kind] = {
        below: 0 - r.tokens[kind].below,
        above: 0 - r.tokens[kind].above,
      };
    return { ...r, tokens };
  });
}

/**
 * The write that drops `sources`' COUNTED token rows from the ledger (origin
 * `counted` — what was imported stays: it is usage of transcripts already gone,
 * which the new owner cannot recount) and their source rows (kept while an
 * imported row still names the source) — for a REATTRIBUTION: the writer files the same usage under
 * another source in the same `writeAtomically` group (a session equin did not
 * launch, adopted by a conversation: its transcripts are recounted under
 * `conv:`). Never for a transcript that vanished — the ledger outlives its
 * files. Two arms; `null` each when there is nothing to drop.
 */
export function usageLedgerDropSources(
  exec: DbExecutor,
  sources: readonly SpendSource[],
): [AtomicWrite, AtomicWrite] {
  if (sources.length === 0) return [null, null];
  return [
    exec
      .delete(_claudeUsageHours)
      .where(
        and(
          inArray(_claudeUsageHours.source, [...sources]),
          eq(_claudeUsageHours.origin, "counted"),
        ),
      ),
    exec
      .delete(_claudeUsageSources)
      .where(
        and(
          inArray(_claudeUsageSources.source, [...sources]),
          sql`NOT EXISTS (SELECT 1 FROM ${_claudeUsageHours} WHERE ${_claudeUsageHours.source} = ${_claudeUsageSources.source} AND ${_claudeUsageHours.origin} = 'imported')`,
        ),
      ),
  ];
}
