import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";

/** A plpgsql function a trigger set installs, named so the installer can find it. */
export interface DbFunctionDdl {
  /** The function's unqualified name (public schema). */
  readonly name: string;
  /** Its argument types as `to_regprocedure` reads them (`"text, text"`, or `""`). */
  readonly args: string;
  /** `CREATE OR REPLACE FUNCTION <name>(…) …` */
  readonly ddl: string;
}

/**
 * One trigger of a set, on one table. Never a CONSTRAINT trigger: Postgres
 * cannot replace one in place, and a deferred one is refused by the change
 * feed on every table it routes (its writes would notify after the
 * transaction's end marker).
 */
export interface DbTriggerDdl {
  readonly name: string;
  readonly table: string;
  /** `CREATE OR REPLACE TRIGGER <name> … ON <table> …` */
  readonly ddl: string;
}

/**
 * A set of database functions and the triggers that call them, installed as
 * one unit by the boot schema layer (`installDbTriggers`): a plugin's
 * invariant the database itself keeps, so no writer can forget it.
 */
export interface DbTriggerSet {
  /** Unique across the app; names the set in logs and in the install lock. */
  readonly id: string;
  readonly functions: readonly DbFunctionDdl[];
  readonly triggers: readonly DbTriggerDdl[];
  /** sha256 over every DDL, stored as each trigger's COMMENT. */
  readonly signature: string;
}

const FUNCTION_HEAD =
  /^\s*CREATE OR REPLACE FUNCTION ("?)([a-z_][a-z0-9_]*)\1\s*\(/i;
const TRIGGER_HEAD =
  /^\s*CREATE OR REPLACE TRIGGER ("?)([a-z_][a-z0-9_]*)\1\s/i;

/**
 * Declare a trigger set. Asserted here, at module eval: every function's DDL
 * creates the function it is named, every trigger's DDL creates the trigger it
 * is named on the table it names — the installer's catalog check reads those
 * names, so a DDL that disagreed with them would reinstall on every boot or,
 * worse, report a trigger present that is not.
 */
export function defineDbTriggers(spec: {
  id: string;
  functions: readonly DbFunctionDdl[];
  triggers: readonly DbTriggerDdl[];
}): DbTriggerSet {
  if (spec.triggers.length === 0) {
    throw new Error(
      `defineDbTriggers("${spec.id}"): a set installs at least one trigger.`,
    );
  }
  for (const f of spec.functions) {
    const head = FUNCTION_HEAD.exec(f.ddl);
    if (head?.[2] !== f.name) {
      throw new Error(
        `defineDbTriggers("${spec.id}"): function "${f.name}"'s DDL must start with \`CREATE OR REPLACE FUNCTION ${f.name}(\`.`,
      );
    }
  }
  for (const t of spec.triggers) {
    const head = TRIGGER_HEAD.exec(t.ddl);
    if (head?.[2] !== t.name) {
      throw new Error(
        `defineDbTriggers("${spec.id}"): trigger "${t.name}"'s DDL must start with \`CREATE OR REPLACE TRIGGER ${t.name}\`.`,
      );
    }
    if (!new RegExp(`\\sON\\s+"?${t.table}"?\\s`, "i").test(t.ddl)) {
      throw new Error(
        `defineDbTriggers("${spec.id}"): trigger "${t.name}"'s DDL must be \`ON ${t.table}\`.`,
      );
    }
  }
  const signature = sha256Hex(
    [
      ...spec.functions.map((f) => f.ddl),
      ...spec.triggers.map((t) => t.ddl),
    ].join("\n--\n"),
  );
  return { ...spec, signature };
}
