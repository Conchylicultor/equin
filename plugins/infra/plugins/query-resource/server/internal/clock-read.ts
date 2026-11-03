import { is, Placeholder, sql, SQL, StringChunk } from "drizzle-orm";

// Compiled live SQL never reads the clock (research/2026-11-03-global-live-
// collections-item7-remaining.md, A4): a routed read's answer must be a pure
// function of its params and the rows it reads, or it goes stale with no
// write to recompute it (a `current_date` window after midnight). What may
// vary with time is declared (network/live's clock forms) and pinned by the
// reader as a query param — rendered here as the ONE `now` slot
// (`clockNow()`), filled per tuple at execution (`pinClock`).

const NOW_NAME = "__live_now";

/**
 * The pinned clock inside compiled SQL: a placeholder for the tuple's `now`
 * (a `timestamptz`), filled by `pinClock` when the tuple's query runs. A
 * clock form's SQL rendering reads it instead of `now()`.
 */
export function clockNow(): SQL {
  return sql`${sql.placeholder(NOW_NAME)}::timestamptz`;
}

function isNowSlot(x: unknown): boolean {
  return is(x, Placeholder) && (x as Placeholder).name === NOW_NAME;
}

/** Whether a fragment reads the `now` slot. */
export function readsClockNow(fragment: SQL): boolean {
  const seen = new Set<object>();
  const walk = (x: unknown): boolean => {
    if (x === null || typeof x !== "object" || seen.has(x)) return false;
    seen.add(x);
    if (isNowSlot(x)) return true;
    if (Array.isArray(x)) return x.some(walk);
    if (is(x, SQL)) return (x as SQL).queryChunks.some(walk);
    if (is(x, SQL.Aliased)) return walk((x as SQL.Aliased).sql);
    return false;
  };
  return walk(fragment);
}

/**
 * Fill a query's `now` slot with the tuple's pinned clock (epoch ms). A query
 * reading the slot with no pin throws — a tuple whose params pin nothing ran a
 * clock read — and so does a pin nothing reads (the params named a clock
 * field the SQL does not read: the compile and the codec disagree).
 */
export function pinClock(
  query: SQL,
  now: number | null | undefined,
  label: string,
): SQL {
  const reads = readsClockNow(query);
  if (!reads) {
    if (now !== null && now !== undefined) {
      throw new Error(
        `${label}: the tuple pins now=${now}, but its SQL reads no clock field — the codec and the compile disagree about which fields read the clock.`,
      );
    }
    return query;
  }
  if (now === null || now === undefined) {
    throw new Error(
      `${label}: the query reads the clock (a clock field in its where / order / projection), but its tuple pins no \`now\` — the reader pins one exactly when it names a clock field.`,
    );
  }
  const at = new Date(now).toISOString();
  const memo = new Map<object, unknown>();
  const sub = (x: unknown): unknown => {
    if (x === null || typeof x !== "object") return x;
    const hit = memo.get(x);
    if (hit !== undefined) return hit;
    let out: unknown = x;
    if (isNowSlot(x)) out = sql`${at}`;
    else if (Array.isArray(x)) out = x.map(sub);
    else if (is(x, SQL)) {
      const s = x as SQL;
      const chunks = s.queryChunks.map(sub);
      if (chunks.some((c, i) => c !== s.queryChunks[i])) {
        // A clone, so everything else the fragment carries (its decoder, its
        // inlining flag) is kept.
        out = Object.assign(
          Object.create(Object.getPrototypeOf(s) as object),
          s,
          {
            queryChunks: chunks,
          },
        ) as SQL;
      }
    } else if (is(x, SQL.Aliased)) {
      const a = x as SQL.Aliased;
      const inner = sub(a.sql) as SQL;
      if (inner !== a.sql) out = inner.as(a.fieldAlias);
    }
    memo.set(x, out);
    return out;
  };
  return sub(query) as SQL;
}

/**
 * Every way Postgres reads the clock or a random source — a function call or
 * a bare SQL-standard keyword. Matched on the SQL TEXT a fragment carries (its
 * string chunks), case-insensitively, as whole words.
 */
const CLOCK_READ =
  /\b(now\s*\(|clock_timestamp\s*\(|statement_timestamp\s*\(|transaction_timestamp\s*\(|timeofday\s*\(|random\s*\(|gen_random_uuid\s*\(|current_date\b|current_time\b|current_timestamp\b|localtime\b|localtimestamp\b)/i;

/**
 * Refuse a fragment of compiled live SQL that reads the clock (`now()`,
 * `current_date`, `clock_timestamp()`, …) or a random source — at the compile
 * entry points (an expression field, an aggregate, a join condition, a static
 * `where`), so a declaration that would go stale at midnight fails at module
 * eval / bind, never later. Declare a clock form instead (network/live's
 * `clockField`, or a `clockParam` on a value).
 */
export function assertStableRead(fragment: unknown, label: string): void {
  const seen = new Set<object>();
  const walk = (x: unknown): void => {
    if (x === null || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    if (is(x, StringChunk)) {
      const text = (x as StringChunk).value.join("");
      const hit = CLOCK_READ.exec(text);
      if (hit !== null) {
        throw new Error(
          `${label} reads the clock (\`${hit[1]!.replace(/\s*\($/, "()")}\` in "${text.trim()}") — compiled live SQL is a pure function of its params and rows, or it goes stale with no write to recompute it. Declare a clock field (\`clockField\`) or a clock param (\`clockParam\`), which the reader pins.`,
        );
      }
      return;
    }
    if (Array.isArray(x)) {
      for (const c of x) walk(c);
      return;
    }
    if (is(x, SQL)) {
      for (const c of (x as SQL).queryChunks) walk(c);
      return;
    }
    if (is(x, SQL.Aliased)) walk((x as SQL.Aliased).sql);
  };
  walk(fragment);
}
