import type { NodePgDatabase } from "drizzle-orm/node-postgres";

type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];
/** What the installer runs on: the app's `db`, or a transaction of it. */
export type DbTriggerExec = NodePgDatabase | Tx;

/** A plpgsql function a trigger set installs, named so the installer can find it. */
export interface DbFunctionDdl {
  /** Its schema (default `public`); the DDL must name it when it is not `public`. */
  readonly schema?: string;
  /** The function's unqualified name. */
  readonly name: string;
  /** Its argument types as `to_regprocedure` reads them (`"text, text"`, or `""`). */
  readonly args: string;
  /** `CREATE OR REPLACE FUNCTION [<schema>.]<name>(…) …` */
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
  /** The table's schema (default `public`). */
  readonly schema?: string;
  readonly table: string;
  /** `CREATE OR REPLACE TRIGGER <name> … ON [<schema>.]<table> …` */
  readonly ddl: string;
  /**
   * The COMMENT an older installer left on this trigger when it installed this
   * very DDL (`null`: it left none, and its own record says so). A trigger
   * found carrying it is ADOPTED — restamped (COMMENT only: SHARE UPDATE
   * EXCLUSIVE, which no writer waits on) rather than re-created (SHARE ROW
   * EXCLUSIVE on its table until the schema layer commits) — so the first boot
   * of the one installer does not lock every table at once during a hot swap.
   * Compatibility only: drop once no supported database predates the stamps.
   */
  readonly legacyStamp?: string | null;
}

/**
 * A set of database functions and the triggers that call them, installed as
 * one unit by the one trigger installer (`installDbTriggers`): a plugin's
 * invariant the database itself keeps, so no writer can forget it.
 */
export interface DbTriggerSet {
  /** Unique across the app; names the set in logs, stamps and the install lock. */
  readonly id: string;
  readonly functions: readonly DbFunctionDdl[];
  readonly triggers: readonly DbTriggerDdl[];
  /**
   * Runs, in the install's transaction, before any of this set's DDL whenever
   * the set has something to (re)install — an assert the DDL's correctness
   * rests on that only the database can check (a rollup's `select` against its
   * declaration). Throwing fails the install.
   */
  readonly beforeInstall?: (exec: DbTriggerExec) => Promise<void>;
}

// An identifier as Postgres reads it: unquoted (folded to lower case), or
// double-quoted (verbatim, `""` an embedded quote — a mixed-case or hyphenated
// table name, e.g. a `defineEvent` triggers table). Two groups: quoted body,
// unquoted word.
const IDENT = `(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))`;

/** The name an `IDENT` match at `at` (its quoted group) denotes, or undefined. */
function identAt(m: RegExpExecArray | null, at: number): string | undefined {
  if (m === null) return undefined;
  const quoted = m[at];
  if (quoted !== undefined) return quoted.replace(/""/g, '"');
  return m[at + 1]?.toLowerCase();
}

// `[<schema>.]<name>`: groups 1–2 the schema when present, 3–4 the name.
const QUALIFIED_NAME = `(?:${IDENT}\\.)?${IDENT}`;

const FUNCTION_HEAD = new RegExp(
  `^\\s*CREATE OR REPLACE FUNCTION ${QUALIFIED_NAME}\\s*\\(`,
  "i",
);
const TRIGGER_HEAD = new RegExp(
  `^\\s*CREATE OR REPLACE TRIGGER ${IDENT}\\s`,
  "i",
);
const TRIGGER_ON = new RegExp(`\\sON\\s+${QUALIFIED_NAME}\\s`, "i");

/** A function's or a trigger table's schema, `public` when unstated. */
export function schemaOf(o: { readonly schema?: string }): string {
  return o.schema ?? "public";
}

/**
 * Declare a trigger set. Asserted here, at module eval: every function's DDL
 * creates the function it is named, in its schema; every trigger's DDL creates
 * the trigger it is named, on the table (and schema) it names — the installer's
 * catalog reads go by those names, so a DDL that disagreed with them would
 * reinstall on every boot or, worse, report a trigger present that is not.
 */
export function defineDbTriggers(spec: DbTriggerSet): DbTriggerSet {
  const fail = (what: string): never => {
    throw new Error(`defineDbTriggers("${spec.id}"): ${what}`);
  };
  if (!/^[A-Za-z0-9_.-]+$/.test(spec.id)) {
    fail(`a set id is [A-Za-z0-9_.-] only (it is a field of every stamp).`);
  }
  if (spec.triggers.length === 0) fail(`a set installs at least one trigger.`);
  const fnKeys = new Set<string>();
  for (const f of spec.functions) {
    const head = FUNCTION_HEAD.exec(f.ddl);
    const schema = identAt(head, 1) ?? "public";
    if (identAt(head, 3) !== f.name || schema !== schemaOf(f)) {
      fail(
        `function "${f.name}"'s DDL must start with \`CREATE OR REPLACE FUNCTION ${schemaOf(f) === "public" ? "" : `${schemaOf(f)}.`}${f.name}(\`.`,
      );
    }
    const key = `${schemaOf(f)}.${f.name}`;
    if (fnKeys.has(key)) fail(`function "${key}" is declared twice.`);
    fnKeys.add(key);
  }
  const triggerKeys = new Set<string>();
  for (const t of spec.triggers) {
    if (identAt(TRIGGER_HEAD.exec(t.ddl), 1) !== t.name) {
      fail(
        `trigger "${t.name}"'s DDL must start with \`CREATE OR REPLACE TRIGGER ${t.name}\`.`,
      );
    }
    const on = TRIGGER_ON.exec(t.ddl);
    if (
      identAt(on, 3) !== t.table ||
      (identAt(on, 1) ?? "public") !== schemaOf(t)
    ) {
      fail(
        `trigger "${t.name}"'s DDL must be \`ON ${schemaOf(t)}.${t.table}\`.`,
      );
    }
    const key = `${schemaOf(t)}.${t.table}.${t.name}`;
    if (triggerKeys.has(key)) fail(`trigger "${key}" is declared twice.`);
    triggerKeys.add(key);
  }
  return spec;
}
