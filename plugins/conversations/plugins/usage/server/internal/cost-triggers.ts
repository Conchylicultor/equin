import { getTableName, sql } from "drizzle-orm";
import { getViewConfig } from "drizzle-orm/pg-core";
import { db, type DbExecutor } from "@plugins/database/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { defineDbTriggers } from "@plugins/database/plugins/db-triggers/server";
import { defineSourceSet } from "@plugins/packages/plugins/source-digest/core";
import { SPEND_SOURCE_PREFIX } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import { _claudeUsageHours } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import {
  _claudeModelRates,
  _claudePriceVersions,
  claudeSpendHoursView,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { conversationUsage } from "./tables";

// ─── What this is ─────────────────────────────────────────────────────────────
//
// The Cost column's numbers — `conversations_ext_usage.cost_usd`, `tokens` and
// `cache_read_tokens` — are DERIVED from the token ledger: a conversation's
// `conv:<id>` rows of `claude_spend_hours_v` (the one pricing function),
// summed. The database keeps them current itself, so no writer can forget to:
//
// - a write to `claude_usage_hours` re-aggregates the conversations whose
//   `conv:` rows it moved (the usage sync, the history import);
// - a write to `claude_model_rates` re-aggregates the conversations that used
//   one of its models in an hour its version prices (a model first priced, a
//   correction's rates);
// - a write to `claude_price_versions` re-aggregates the conversations with an
//   hour at or after the earliest `effective_from` it moved (a refresh's new
//   version, effective now, moves nothing; a correction moves what it covers).
//
// `agent_count` is not derived here: the sync writes it from its scan state.
//
// Why not a `derived-tables` rollup: a rollup owns its table (created at boot,
// every column its aggregate's), while this one is an entity extension — the
// migration-managed side table every conversation list joins for its exposed
// fields, sharing its row with `agent_count`. So the maintenance is the
// rollup's, by hand, over the three columns: one statement-level trigger per
// source and op (transition tables), a transaction-scoped advisory lock per
// conversation in sorted order before aggregating (a concurrent writer of the
// same conversation then aggregates in a fresh statement that sees this one's
// rows — derived-tables' A34), and a guarded upsert (an unchanged row keeps its
// xmin, so the change feed hears of a conversation only when its numbers
// moved). The repair a rollup's boot reconcile gives is `reconcileUsageCosts`,
// run by a warm-up once per change of this module (`usageCostCode`).
//
// An hour the view cannot price (`cost_usd` NULL) adds nothing to the cost —
// the `cost-unpriced-model` report (stats/cost) is where that shows.

/** The code the derived columns are computed by: the warm-up re-runs the repair when it changes. */
export const usageCostCode = defineSourceSet(
  "how a conversation's cost and tokens are derived from the token ledger",
);
usageCostCode.include(import.meta);

const EXT = getTableName(conversationUsage.table);
const HOURS = getTableName(_claudeUsageHours);
const RATES = getTableName(_claudeModelRates);
const VERSIONS = getTableName(_claudePriceVersions);
const VIEW = getViewConfig(claudeSpendHoursView).name;
const CONVERSATIONS = getTableName(_conversations);
const CONV = SPEND_SOURCE_PREFIX.conversation;
const CONV_LIKE = `'${CONV}%'`;
const convIdOf = (col: string): string => `substr(${col}, ${CONV.length + 1})`;

/** The advisory-lock class of a conversation's derived cost (two-int form). */
const LOCK_CLASS = 0x75_63_6f_73; // "ucos"

const MAINTAIN = "conversations_ext_usage_cost_maintain";

const MAINTAIN_FN = `CREATE OR REPLACE FUNCTION public.${MAINTAIN}(keys text[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  IF keys IS NULL OR cardinality(keys) = 0 THEN RETURN; END IF;
  FOR k IN SELECT DISTINCT x FROM unnest(keys) AS x ORDER BY x LOOP
    PERFORM pg_advisory_xact_lock(${LOCK_CLASS}, hashtext(k));
  END LOOP;
  INSERT INTO public.${EXT} AS t (parent_id, cost_usd, tokens, cache_read_tokens)
  SELECT c.id,
         coalesce(a.cost_usd, 0),
         coalesce(a.tokens, 0),
         coalesce(a.cache_read_tokens, 0)
    FROM public.${CONVERSATIONS} c
    LEFT JOIN LATERAL (
      SELECT sum(v.cost_usd)::float8 AS cost_usd,
             sum(v.input_below + v.input_above
               + v.output_below + v.output_above
               + v.cache_create_5m_below + v.cache_create_5m_above
               + v.cache_create_1h_below + v.cache_create_1h_above)::float8 AS tokens,
             sum(v.cache_read_below + v.cache_read_above)::float8 AS cache_read_tokens
        FROM public.${VIEW} v
       WHERE v.source = '${CONV}' || c.id
    ) a ON true
   WHERE c.id = ANY(keys)
  ON CONFLICT (parent_id) DO UPDATE
     SET cost_usd = EXCLUDED.cost_usd,
         tokens = EXCLUDED.tokens,
         cache_read_tokens = EXCLUDED.cache_read_tokens
   WHERE (t.cost_usd, t.tokens, t.cache_read_tokens)
         IS DISTINCT FROM (EXCLUDED.cost_usd, EXCLUDED.tokens, EXCLUDED.cache_read_tokens);
END;
$$`;

/** A trigger function re-aggregating the keys `keysOf(<transition table>)` names. */
function onSource(
  name: string,
  keysOf: (rows: "new_rows" | "old_rows") => string,
): string {
  return `CREATE OR REPLACE FUNCTION public.${name}()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.${MAINTAIN}(ARRAY(${keysOf("new_rows")}));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.${MAINTAIN}(ARRAY(${keysOf("old_rows")}));
  ELSE
    PERFORM public.${MAINTAIN}(ARRAY(${keysOf("new_rows")} UNION ${keysOf("old_rows")}));
  END IF;
  RETURN NULL;
END;
$$`;
}

const ON_HOURS = "conversations_ext_usage_cost_on_hours";
const ON_RATES = "conversations_ext_usage_cost_on_rates";
const ON_VERSIONS = "conversations_ext_usage_cost_on_versions";

// A ledger write: the conversations whose `conv:` rows it moved.
const hoursKeys = (rows: string): string =>
  `SELECT DISTINCT ${convIdOf("r.source")} FROM ${rows} r WHERE r.source LIKE ${CONV_LIKE}`;

// A rate write: the conversations that used its model in an hour its version
// is in force from (a later version's hours are re-aggregated too — they
// price the same; the guarded upsert writes nothing for them).
const ratesKeys = (rows: string): string =>
  `SELECT DISTINCT ${convIdOf("u.source")}
     FROM ${rows} r
     JOIN public.${VERSIONS} pv ON pv.id = r.version_id
     JOIN public.${HOURS} u ON u.model = r.model AND u.speed = r.speed AND u.hour >= pv.effective_from
    WHERE u.source LIKE ${CONV_LIKE}`;

// A version write: the conversations with an hour at or after the earliest
// `effective_from` it moved (an inserted, deleted or re-dated version).
const versionsKeys = (rows: string): string =>
  `SELECT DISTINCT ${convIdOf("u.source")}
     FROM public.${HOURS} u
    WHERE u.source LIKE ${CONV_LIKE}
      AND u.hour >= (SELECT min(r.effective_from) FROM ${rows} r)`;

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

export const usageCostTriggers = defineDbTriggers({
  id: "conversations.usage.cost",
  functions: [
    { name: MAINTAIN, args: "text[]", ddl: MAINTAIN_FN },
    { name: ON_HOURS, args: "", ddl: onSource(ON_HOURS, hoursKeys) },
    { name: ON_RATES, args: "", ddl: onSource(ON_RATES, ratesKeys) },
    { name: ON_VERSIONS, args: "", ddl: onSource(ON_VERSIONS, versionsKeys) },
  ],
  triggers: [
    ...triggersOn(HOURS, ON_HOURS),
    ...triggersOn(RATES, ON_RATES),
    ...triggersOn(VERSIONS, ON_VERSIONS),
  ],
});

/**
 * Bring every conversation's derived cost and tokens to the ledger's: the
 * conversations with `conv:` ledger rows, and those whose row holds a count
 * the ledger does not back (a row written before the columns were derived).
 * Writes only the rows that differ. The triggers keep the columns current;
 * this is their repair, run once per change of the code above.
 */
export async function reconcileUsageCosts(exec: DbExecutor): Promise<void> {
  await exec.execute(
    sql.raw(`SELECT public.${MAINTAIN}(ARRAY(
      SELECT DISTINCT ${convIdOf("u.source")} FROM public.${HOURS} u WHERE u.source LIKE ${CONV_LIKE}
      UNION
      SELECT e.parent_id FROM public.${EXT} e
       WHERE e.cost_usd <> 0 OR e.tokens <> 0 OR e.cache_read_tokens <> 0
    ))`),
  );
}

/**
 * The repair, as a boot warm-up: once per change of this module's code (and
 * on a database that never ran it) — the first boot of the derived columns
 * replaces the counts the sync wrote before them.
 */
export const usageCostWarmup = defineWarmup({
  name: "conversations.usage.cost-reconcile",
  description:
    "Brings each conversation's cost and token totals in line with the token ledger after the way they are derived changes.",
  scope: "worktree",
  derivedFrom: () => [usageCostCode],
  run: () => reconcileUsageCosts(db),
});
