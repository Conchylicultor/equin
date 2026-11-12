import {
  defineDbTriggers,
  type DbFunctionDdl,
  type DbTriggerDdl,
  type DbTriggerSet,
} from "@plugins/database/plugins/db-triggers/server";
import type { MirroredTable, MirrorSetDefinition } from "./define";
import { ident, lit, pkJson } from "./sql";

/** The db-triggers set id; claimed with `DbTriggerClaim` (installed in onReadyBlocking). */
export const TABLE_MIRROR_TRIGGER_SET = "table-mirror";

const TRUNCATED_FUNCTION = "tm_truncated";

function logFunction(
  set: MirrorSetDefinition,
  t: MirroredTable,
): DbFunctionDdl {
  const name = `tm_log_${t.name}`;
  const upsertInto = (from: string, deleted: boolean, where = "") =>
    // sql-writes:hand-written — the generated trigger body: a set-based upsert from the statement's transition table into the log
    `
    INSERT INTO table_mirror_log (set_id, tbl, pk, xid, deleted)
    SELECT ${lit(set.id)}, ${lit(t.name)}, ${pkJson(t, "r")}, pg_current_xact_id(), ${deleted}
    FROM ${from} r${where}
    ON CONFLICT (tbl, pk) DO UPDATE
      SET set_id = excluded.set_id, xid = excluded.xid, deleted = excluded.deleted;`;
  const keyChanged = t.pk
    .map((c) => `n.${ident(c.name)} = r.${ident(c.name)}`)
    .join(" AND ");
  // One function per table, static SQL over the statement's transition tables:
  // one log row per key the statement touched, the newest change winning. An
  // UPDATE that moves a key tombstones the old one. A DELETE cascaded from a
  // parent fires this table's own statement trigger with its own transition
  // table (pinned by cascade-assumption.test.ts), so cascades are logged too.
  const ddl = `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $tm$
BEGIN
  IF TG_OP = 'INSERT' THEN${upsertInto("new_rows", false)}
  ELSIF TG_OP = 'UPDATE' THEN${upsertInto(
    "old_rows",
    true,
    `\n    WHERE NOT EXISTS (SELECT 1 FROM new_rows n WHERE ${keyChanged})`,
  )}${upsertInto("new_rows", false)}
  ELSE${upsertInto("old_rows", true)}
  END IF;
  RETURN NULL;
END
$tm$`;
  return { name, args: "", ddl };
}

function tableTriggers(t: MirroredTable): DbTriggerDdl[] {
  const fn = `tm_log_${t.name}`;
  const on = (
    suffix: string,
    event: string,
    transition: string,
    exec: string,
  ) => ({
    name: `tm_${t.name}_${suffix}`,
    table: t.name,
    ddl: `CREATE OR REPLACE TRIGGER tm_${t.name}_${suffix} AFTER ${event} ON ${ident(t.name)}${transition} FOR EACH STATEMENT EXECUTE FUNCTION ${exec}()`,
  });
  return [
    on("i", "INSERT", " REFERENCING NEW TABLE AS new_rows", fn),
    on(
      "u",
      "UPDATE",
      " REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows",
      fn,
    ),
    on("d", "DELETE", " REFERENCING OLD TABLE AS old_rows", fn),
    on("t", "TRUNCATE", "", TRUNCATED_FUNCTION),
  ];
}

// A TRUNCATE has no transition table: the log cannot say which keys went. So
// the table's log rows are dropped (an upsert row would point at nothing) and
// the source's epoch moves, which makes every replica reconcile.
const truncatedFunction: DbFunctionDdl = {
  name: TRUNCATED_FUNCTION,
  args: "",
  ddl: `CREATE OR REPLACE FUNCTION ${TRUNCATED_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $tm$
BEGIN
  DELETE FROM table_mirror_log WHERE tbl = TG_TABLE_NAME;
  UPDATE table_mirror_source SET epoch = epoch + 1;
  RETURN NULL;
END
$tm$`,
};

/**
 * The change-log trigger set for every contributed mirror set: per table, one
 * plpgsql function and statement-level INSERT / UPDATE / DELETE triggers with
 * transition tables, plus a TRUNCATE trigger. A table no longer declared has its
 * triggers dropped (the installer drops what the set owns but no longer
 * declares). Called only with at least one table: db-triggers refuses an
 * empty set.
 */
export function mirrorTriggerSet(
  sets: readonly MirrorSetDefinition[],
): DbTriggerSet {
  const tables = sets.flatMap((s) => s.tables.map((t) => ({ set: s, t })));
  return defineDbTriggers({
    id: TABLE_MIRROR_TRIGGER_SET,
    functions: [
      truncatedFunction,
      ...tables.map(({ set, t }) => logFunction(set, t)),
    ],
    triggers: tables.flatMap(({ t }) => tableTriggers(t)),
  });
}
