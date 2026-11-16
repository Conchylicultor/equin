import { getTableName, sql } from "drizzle-orm";
import { getViewConfig } from "drizzle-orm/pg-core";
import { db, type DbExecutor } from "@plugins/database/server";
import { defineDbTriggers } from "@plugins/database/plugins/db-triggers/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { defineSourceSet } from "@plugins/packages/plugins/source-digest/core";
import {
  _claudeUsageHours,
  _claudeUsageSources,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import {
  _claudeModelRates,
  _claudePriceVersions,
  claudeSpendHoursView,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { _claudeSpendDays, _claudeSpendSources } from "./tables";

// ─── What this is ─────────────────────────────────────────────────────────────
//
// The two Stats → Cost rollups (`./tables.ts`) are DERIVED from the priced
// ledger (`claude_spend_hours_v`, the one pricing function) by the database:
//
// - `claude_spend_sources`, keyed by source, re-aggregated for the sources a
//   write moved;
// - `claude_spend_days`, keyed by UTC day, re-aggregated (every model and repo
//   flag of the day) for the days a write moved.
//
// What moves a key:
// - a `claude_usage_hours` write — its rows' sources and days (a usage-sync
//   pass, a CLI call, the history import);
// - a `claude_model_rates` write — the sources / days with an hour of its model
//   at or after its version's `effective_from` (a model first priced, a
//   correction's rates; a refresh's new version, effective now, has none);
// - a `claude_price_versions` write — every hour at or after the earliest
//   `effective_from` it moved;
// - a `claude_usage_sources` write that flips a source's `is_repo` (or
//   creates / deletes its row) — that source's days (days only: the sources
//   rollup is joined to its row at read).
//
// The maintenance is derived-tables' (A34) by hand — one statement-level
// trigger per source table and op (transition tables), a transaction-scoped
// advisory lock per key in sorted order before aggregating, a guarded upsert
// (an unchanged row keeps its xmin, so the change feed hears of a key only when
// its numbers moved) and a delete of a key with nothing left — because a
// `derived-tables` rollup's `select` may read only declared source tables, and
// this one reads the view (the same choice as conversations/usage's Cost
// column, `cost-triggers.ts`). `reconcileCostRollups` is the repair, run by a
// warm-up once per change of this module (`costRollupCode`).

/** The code the rollups are computed by: the warm-up re-runs the repair when it changes. */
export const costRollupCode = defineSourceSet(
  "how Stats → Cost's per-source and per-day rollups are derived from the priced ledger",
);
costRollupCode.include(import.meta);

const HOURS = getTableName(_claudeUsageHours);
const USAGE_SOURCES = getTableName(_claudeUsageSources);
const RATES = getTableName(_claudeModelRates);
const VERSIONS = getTableName(_claudePriceVersions);
const VIEW = getViewConfig(claudeSpendHoursView).name;
const SOURCES = getTableName(_claudeSpendSources);
const DAYS = getTableName(_claudeSpendDays);

/** Advisory-lock classes (two-int form): "csrc", "cday". */
const SOURCE_LOCK = 0x63_73_72_63;
const DAY_LOCK = 0x63_64_61_79;

const MAINTAIN_SOURCES = "claude_spend_sources_maintain";
const MAINTAIN_DAYS = "claude_spend_days_maintain";

/** The token sums both rollups store, over the view's rows `v`. */
const SUMS = `coalesce(sum(v.cost_usd), 0)::float8 AS cost_usd,
         sum(v.input_below + v.input_above)::bigint AS input,
         sum(v.output_below + v.output_above)::bigint AS output,
         sum(v.cache_create_5m_below + v.cache_create_5m_above
           + v.cache_create_1h_below + v.cache_create_1h_above)::bigint AS cache_creation,
         sum(v.cache_read_below + v.cache_read_above)::bigint AS cache_read`;

const VALUES = ["cost_usd", "input", "output", "cache_creation", "cache_read"];
const setValues = (extra: string[]): string =>
  [...VALUES, ...extra].map((c) => `${c} = EXCLUDED.${c}`).join(", ");
const distinct = (extra: string[]): string => {
  const cols = [...VALUES, ...extra];
  return `(${cols.map((c) => `t.${c}`).join(", ")}) IS DISTINCT FROM (${cols.map((c) => `EXCLUDED.${c}`).join(", ")})`;
};

/** A UTC day's first instant, as a timestamptz. */
const dayStart = (day: string): string =>
  `(${day}::timestamp AT TIME ZONE 'UTC')`;
/** The UTC day of a timestamptz. */
const utcDay = (instant: string): string =>
  `(${instant} AT TIME ZONE 'UTC')::date`;

const MAINTAIN_SOURCES_FN = `CREATE OR REPLACE FUNCTION public.${MAINTAIN_SOURCES}(keys text[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  IF keys IS NULL OR cardinality(keys) = 0 THEN RETURN; END IF;
  FOR k IN SELECT DISTINCT x FROM unnest(keys) AS x ORDER BY x LOOP
    PERFORM pg_advisory_xact_lock(${SOURCE_LOCK}, hashtext(k));
  END LOOP;
  DELETE FROM public.${SOURCES} t
   WHERE t.source = ANY(keys)
     AND NOT EXISTS (SELECT 1 FROM public.${HOURS} u WHERE u.source = t.source);
  INSERT INTO public.${SOURCES} AS t
         (source, cost_usd, input, output, cache_creation, cache_read, last_hour, models)
  SELECT v.source, ${SUMS},
         max(v.hour) AS last_hour,
         array_agg(DISTINCT v.model ORDER BY v.model) AS models
    FROM public.${VIEW} v
   WHERE v.source = ANY(keys)
   GROUP BY v.source
  ON CONFLICT (source) DO UPDATE
     SET ${setValues(["last_hour", "models"])}
   WHERE ${distinct(["last_hour", "models"])};
END;
$$`;

const MAINTAIN_DAYS_FN = `CREATE OR REPLACE FUNCTION public.${MAINTAIN_DAYS}(keys date[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE k date;
BEGIN
  IF keys IS NULL OR cardinality(keys) = 0 THEN RETURN; END IF;
  FOR k IN SELECT DISTINCT x FROM unnest(keys) AS x ORDER BY x LOOP
    PERFORM pg_advisory_xact_lock(${DAY_LOCK}, (k - DATE '2000-01-01'));
  END LOOP;
  DELETE FROM public.${DAYS} t
   WHERE t.day = ANY(keys)
     AND NOT EXISTS (
       SELECT 1
         FROM public.${HOURS} u
         LEFT JOIN public.${USAGE_SOURCES} s ON s.source = u.source
        WHERE u.hour >= ${dayStart("t.day")}
          AND u.hour < ${dayStart("(t.day + 1)")}
          AND u.model = t.model
          AND coalesce(s.is_repo, false) = t.is_repo);
  INSERT INTO public.${DAYS} AS t
         (day, model, is_repo, cost_usd, input, output, cache_creation, cache_read)
  SELECT d.day, v.model, coalesce(s.is_repo, false), ${SUMS}
    FROM (SELECT DISTINCT x AS day FROM unnest(keys) AS x) d
    JOIN public.${VIEW} v
      ON v.hour >= ${dayStart("d.day")} AND v.hour < ${dayStart("(d.day + 1)")}
    LEFT JOIN public.${USAGE_SOURCES} s ON s.source = v.source
   GROUP BY d.day, v.model, coalesce(s.is_repo, false)
  ON CONFLICT (day, model, is_repo) DO UPDATE
     SET ${setValues([])}
   WHERE ${distinct([])};
END;
$$`;

/** Each rollup's keys a statement's transition table `rows` moved. */
interface Keys {
  sources: (rows: string) => string;
  days: (rows: string) => string;
}

// A ledger write: its rows' own sources and days.
const hoursKeys: Keys = {
  sources: (rows) => `SELECT DISTINCT r.source FROM ${rows} r`,
  days: (rows) => `SELECT DISTINCT ${utcDay("r.hour")} FROM ${rows} r`,
};

// A rate write: the hours of its model its version is in force from (a later
// version's hours are re-aggregated too — they price the same; the guarded
// upsert writes nothing for them).
const ratedHours = (rows: string, col: string): string =>
  `SELECT DISTINCT ${col}
     FROM ${rows} r
     JOIN public.${VERSIONS} pv ON pv.id = r.version_id
     JOIN public.${HOURS} u ON u.model = r.model AND u.speed = r.speed AND u.hour >= pv.effective_from`;
const ratesKeys: Keys = {
  sources: (rows) => ratedHours(rows, "u.source"),
  days: (rows) => ratedHours(rows, utcDay("u.hour")),
};

// A version write: every hour at or after the earliest `effective_from` it
// moved (an inserted, deleted or re-dated version).
const versionHours = (rows: string, col: string): string =>
  `SELECT DISTINCT ${col}
     FROM public.${HOURS} u
    WHERE u.hour >= (SELECT min(r.effective_from) FROM ${rows} r)`;
const versionsKeys: Keys = {
  sources: (rows) => versionHours(rows, "u.source"),
  days: (rows) => versionHours(rows, utcDay("u.hour")),
};

/** A trigger function re-aggregating the keys `keys` names, for both rollups. */
function onSource(name: string, keys: Keys): string {
  const both = (rows: "new_rows" | "old_rows" | "both"): string => {
    const of = (f: (r: string) => string) =>
      rows === "both" ? `${f("new_rows")} UNION ${f("old_rows")}` : f(rows);
    return `PERFORM public.${MAINTAIN_SOURCES}(ARRAY(${of(keys.sources)}));
    PERFORM public.${MAINTAIN_DAYS}(ARRAY(${of(keys.days)}));`;
  };
  return `CREATE OR REPLACE FUNCTION public.${name}()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    ${both("new_rows")}
  ELSIF TG_OP = 'DELETE' THEN
    ${both("old_rows")}
  ELSE
    ${both("both")}
  END IF;
  RETURN NULL;
END;
$$`;
}

// A sources-row write: the days of the sources whose repo flag it set, moved
// or cleared — a new row (`is_repo` read as false before it), a deleted one,
// or an update that changed the flag. A title or project dir moves nothing.
const ON_USAGE_SOURCES_FN = (name: string): string => {
  const daysOf = (sources: string) =>
    `SELECT DISTINCT ${utcDay("u.hour")} FROM public.${HOURS} u WHERE u.source IN (${sources})`;
  return `CREATE OR REPLACE FUNCTION public.${name}()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.${MAINTAIN_DAYS}(ARRAY(${daysOf("SELECT r.source FROM new_rows r WHERE r.is_repo")}));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.${MAINTAIN_DAYS}(ARRAY(${daysOf("SELECT r.source FROM old_rows r WHERE r.is_repo")}));
  ELSE
    PERFORM public.${MAINTAIN_DAYS}(ARRAY(${daysOf(
      `SELECT n.source FROM new_rows n JOIN old_rows o ON o.source = n.source
        WHERE n.is_repo IS DISTINCT FROM o.is_repo
       UNION SELECT n.source FROM new_rows n WHERE n.is_repo
         AND NOT EXISTS (SELECT 1 FROM old_rows o WHERE o.source = n.source)
       UNION SELECT o.source FROM old_rows o WHERE o.is_repo
         AND NOT EXISTS (SELECT 1 FROM new_rows n WHERE n.source = o.source)`,
    )}));
  END IF;
  RETURN NULL;
END;
$$`;
};

const ON_HOURS = "claude_spend_rollups_on_hours";
const ON_RATES = "claude_spend_rollups_on_rates";
const ON_VERSIONS = "claude_spend_rollups_on_versions";
const ON_USAGE_SOURCES = "claude_spend_rollups_on_usage_sources";

/** One statement-level trigger per op, each with the transition tables its op has. */
function triggersOn(table: string, fn: string) {
  const ops = [
    { op: "INSERT", suffix: "i", refs: "REFERENCING NEW TABLE AS new_rows" },
    {
      op: "UPDATE",
      suffix: "u",
      refs: "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows",
    },
    { op: "DELETE", suffix: "d", refs: "REFERENCING OLD TABLE AS old_rows" },
  ];
  return ops.map(({ op, suffix, refs }) => {
    const name = `${fn}_${suffix}`;
    return {
      name,
      table,
      ddl: `CREATE OR REPLACE TRIGGER ${name}
  AFTER ${op} ON public.${table}
  ${refs}
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.${fn}()`,
    };
  });
}

export const costRollupTriggers = defineDbTriggers({
  id: "stats.cost.rollups",
  functions: [
    { name: MAINTAIN_SOURCES, args: "text[]", ddl: MAINTAIN_SOURCES_FN },
    { name: MAINTAIN_DAYS, args: "date[]", ddl: MAINTAIN_DAYS_FN },
    { name: ON_HOURS, args: "", ddl: onSource(ON_HOURS, hoursKeys) },
    { name: ON_RATES, args: "", ddl: onSource(ON_RATES, ratesKeys) },
    { name: ON_VERSIONS, args: "", ddl: onSource(ON_VERSIONS, versionsKeys) },
    {
      name: ON_USAGE_SOURCES,
      args: "",
      ddl: ON_USAGE_SOURCES_FN(ON_USAGE_SOURCES),
    },
  ],
  triggers: [
    ...triggersOn(HOURS, ON_HOURS),
    ...triggersOn(RATES, ON_RATES),
    ...triggersOn(VERSIONS, ON_VERSIONS),
    ...triggersOn(USAGE_SOURCES, ON_USAGE_SOURCES),
  ],
});

/**
 * Bring both rollups to the priced ledger: every source and day the ledger
 * has, and every one a rollup holds (a key with nothing left is deleted).
 * Writes only the rows that differ. The triggers keep them current; this is
 * their repair, run once per change of the code above.
 */
export async function reconcileCostRollups(exec: DbExecutor): Promise<void> {
  await exec.execute(
    sql.raw(`SELECT public.${MAINTAIN_SOURCES}(ARRAY(
      SELECT DISTINCT u.source FROM public.${HOURS} u
      UNION SELECT t.source FROM public.${SOURCES} t
    ))`),
  );
  await exec.execute(
    sql.raw(`SELECT public.${MAINTAIN_DAYS}(ARRAY(
      SELECT DISTINCT ${utcDay("u.hour")} FROM public.${HOURS} u
      UNION SELECT t.day FROM public.${DAYS} t
    ))`),
  );
}

/**
 * The repair, as a boot warm-up: once per change of this module's code (and
 * on a database that never ran it — the first boot of the rollups fills them).
 */
export const costRollupWarmup = defineWarmup({
  name: "stats.cost.rollups-reconcile",
  description:
    "Brings the Stats → Cost per-session and per-day totals in line with the priced usage ledger after the way they are derived changes.",
  scope: "worktree",
  derivedFrom: () => [costRollupCode],
  run: () => reconcileCostRollups(db),
});
