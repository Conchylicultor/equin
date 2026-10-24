// The closed statement table for schema migrations: every DDL statement drizzle
// generates is expand, contract or rejected, and anything else is unknown. See
// research/2026-09-29-global-phased-migrations.md §1.
//
// - expand: permissive — existing rows and the code already deployed stay valid.
//   Runs before the push's data migrations, so a backfill sees the new shape.
// - contract: restrictive or data-destroying. Runs after the data migrations.
// - split: `ADD COLUMN c T NOT NULL` with no DEFAULT — an expand `ADD COLUMN c T`
//   plus a contract `SET NOT NULL`, so "new required column + backfill" is one
//   push.
// - reject: never belongs in a schema migration.
// - unknown: the table does not cover it. The generator fails loudly naming the
//   statement; extend the table rather than working around it.
//
// Reads `Statement.code` (trivia blanked, see ./statements.ts), so an identifier
// is a `"…"` token whose contents are spaces and no keyword inside a name or a
// literal can match. Pure: no DB, no git, no I/O.

import { splitStatements, type Statement } from "./statements";

export type ExpandOp =
  | "create-table"
  | "create-index"
  | "create-sequence"
  | "create-domain"
  | "add-column"
  | "set-default"
  | "drop-default"
  | "drop-not-null"
  | "drop-constraint"
  | "drop-index"
  | "row-level-security"
  | "rename-column"
  | "rename-table";

export type ContractOp =
  | "drop-table"
  | "drop-column"
  | "drop-sequence"
  | "drop-type"
  | "set-not-null"
  | "set-data-type"
  | "add-constraint"
  | "create-unique-index";

export type RejectOp = "view" | "enum-add-value" | "dml";

export type StatementClass =
  | { kind: "expand"; op: ExpandOp }
  | { kind: "contract"; op: ContractOp }
  | {
      kind: "split";
      op: "add-column-not-null";
      expand: string;
      contract: string;
    }
  | { kind: "reject"; op: RejectOp; reason: string }
  | { kind: "unknown"; reason: string };

export type StatementOp =
  ExpandOp | ContractOp | RejectOp | "add-column-not-null";

// An identifier as the mask leaves it: a quoted one (contents blanked) or a bare
// word. QNAME allows one schema qualifier.
const IDENT = String.raw`(?:"[^"]*"|[A-Za-z_][\w$]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;

const re = (src: string) => new RegExp(src, "i");

// Whole-statement forms, tried in order; the first match wins.
const TOP_LEVEL: ReadonlyArray<{ re: RegExp; cls: StatementClass }> = [
  {
    re: re(
      String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\b`,
    ),
    cls: {
      kind: "reject",
      op: "view",
      reason:
        "views are derived code (a View contribution rebuilt after every migration), never migration DDL — remove the view from schema.ts and declare it in the plugin's views.ts",
    },
  },
  {
    re: re(String.raw`^DROP\s+(?:MATERIALIZED\s+)?VIEW\b`),
    cls: {
      kind: "reject",
      op: "view",
      reason:
        "views are derived code (a View contribution rebuilt after every migration), never migration DDL — remove the view from schema.ts and declare it in the plugin's views.ts",
    },
  },
  {
    re: re(String.raw`^ALTER\s+TYPE\s+${QNAME}\s+ADD\s+VALUE\b`),
    cls: {
      kind: "reject",
      op: "enum-add-value",
      reason:
        "a new enum value cannot be used in the transaction that adds it, and the whole boot schema layer is one transaction. No pgEnum exists in this repo today; use a text column with a zod-validated union (sql-column's parsedText) instead",
    },
  },
  {
    re: re(String.raw`^(?:INSERT|UPDATE|DELETE|TRUNCATE|WITH|SELECT|MERGE)\b`),
    cls: {
      kind: "reject",
      op: "dml",
      reason:
        "DML belongs in a data migration (./equin build --custom-migration --migration-name <slug>), which this schema migration then claims and runs between expand and contract",
    },
  },
  {
    re: re(String.raw`^CREATE\s+(?:UNLOGGED\s+)?TABLE\b`),
    cls: { kind: "expand", op: "create-table" },
  },
  {
    re: re(String.raw`^CREATE\s+INDEX\s+(?!CONCURRENTLY\b)`),
    cls: { kind: "expand", op: "create-index" },
  },
  {
    re: re(String.raw`^CREATE\s+UNIQUE\s+INDEX\s+(?!CONCURRENTLY\b)`),
    cls: { kind: "contract", op: "create-unique-index" },
  },
  {
    re: re(String.raw`^CREATE\s+SEQUENCE\b`),
    cls: { kind: "expand", op: "create-sequence" },
  },
  {
    re: re(String.raw`^CREATE\s+DOMAIN\b`),
    cls: { kind: "expand", op: "create-domain" },
  },
  {
    re: re(String.raw`^DROP\s+TABLE\b`),
    cls: { kind: "contract", op: "drop-table" },
  },
  {
    re: re(String.raw`^DROP\s+INDEX\s+(?!CONCURRENTLY\b)`),
    cls: { kind: "expand", op: "drop-index" },
  },
  {
    re: re(String.raw`^DROP\s+SEQUENCE\b`),
    cls: { kind: "contract", op: "drop-sequence" },
  },
  {
    re: re(String.raw`^DROP\s+TYPE\b`),
    cls: { kind: "contract", op: "drop-type" },
  },
];

// `ALTER TABLE [IF EXISTS] [ONLY] <name> <action>` — the action is matched
// against ALTER_ACTIONS. Group 1 is the table name, group 2 the action.
const ALTER_TABLE = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QNAME})\s+([\s\S]*)$`,
  "id",
);

// One ALTER TABLE action. `ADD COLUMN` is handled separately (it may split).
const ALTER_ACTIONS: ReadonlyArray<{ re: RegExp; cls: StatementClass }> = [
  {
    re: re(String.raw`^ALTER\s+COLUMN\s+${IDENT}\s+SET\s+DEFAULT\b`),
    cls: { kind: "expand", op: "set-default" },
  },
  {
    re: re(String.raw`^ALTER\s+COLUMN\s+${IDENT}\s+DROP\s+DEFAULT$`),
    cls: { kind: "expand", op: "drop-default" },
  },
  {
    re: re(String.raw`^ALTER\s+COLUMN\s+${IDENT}\s+DROP\s+NOT\s+NULL$`),
    cls: { kind: "expand", op: "drop-not-null" },
  },
  {
    re: re(String.raw`^ALTER\s+COLUMN\s+${IDENT}\s+SET\s+NOT\s+NULL$`),
    cls: { kind: "contract", op: "set-not-null" },
  },
  {
    re: re(String.raw`^ALTER\s+COLUMN\s+${IDENT}\s+(?:SET\s+DATA\s+)?TYPE\b`),
    cls: { kind: "contract", op: "set-data-type" },
  },
  {
    re: re(String.raw`^DROP\s+COLUMN\b`),
    cls: { kind: "contract", op: "drop-column" },
  },
  {
    re: re(String.raw`^DROP\s+CONSTRAINT\b`),
    cls: { kind: "expand", op: "drop-constraint" },
  },
  {
    re: re(String.raw`^ADD\s+CONSTRAINT\b`),
    cls: { kind: "contract", op: "add-constraint" },
  },
  {
    re: re(String.raw`^(?:ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY$`),
    cls: { kind: "expand", op: "row-level-security" },
  },
  {
    re: re(String.raw`^RENAME\s+(?:COLUMN\s+)?${IDENT}\s+TO\s+${IDENT}$`),
    cls: { kind: "expand", op: "rename-column" },
  },
  {
    re: re(String.raw`^RENAME\s+TO\s+${IDENT}$`),
    cls: { kind: "expand", op: "rename-table" },
  },
];

// `ADD COLUMN [IF NOT EXISTS] <col> <definition>`. Group 1 is the column name.
const ADD_COLUMN = new RegExp(
  String.raw`^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+[\s\S]+$`,
  "id",
);
// Column-definition clauses that add a constraint or a computed value — not a
// plain column, so neither expand nor safely splittable.
const ADD_COLUMN_CONSTRAINT =
  /\b(?:PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|GENERATED)\b/i;
const NOT_NULL = /\bNOT\s+NULL\b/i;
const DEFAULT = /\bDEFAULT\b/i;

// drizzle 0.28's foreign-key form: one ADD CONSTRAINT … FOREIGN KEY wrapped in a
// DO block that swallows `duplicate_object`. Matched on RAW text, since the mask
// blanks the dollar-quoted body.
const DO_FOREIGN_KEY = re(
  String.raw`^DO\s+\$\$\s*BEGIN\s+ALTER\s+TABLE\s+[^;]+?\s+ADD\s+CONSTRAINT\s+[^;]+?\s+FOREIGN\s+KEY\b[^;]*;\s*EXCEPTION\s+WHEN\s+duplicate_object\s+THEN\s+null\s*;\s*END\s*\$\$$`,
);

// A `,` outside every parenthesis: an ALTER TABLE carrying several actions.
function hasTopLevelComma(code: string): boolean {
  let depth = 0;
  for (const ch of code) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return true;
  }
  return false;
}

/** Classify one statement against the closed table. Never throws. */
export function classifyStatement(stmt: Statement): StatementClass {
  const { code, raw } = stmt;

  if (/^DO\b/i.test(code)) {
    return DO_FOREIGN_KEY.test(raw)
      ? { kind: "contract", op: "add-constraint" }
      : {
          kind: "unknown",
          reason:
            "a DO block other than drizzle's ADD CONSTRAINT … FOREIGN KEY form",
        };
  }

  for (const t of TOP_LEVEL) if (t.re.test(code)) return t.cls;

  const alter = ALTER_TABLE.exec(code);
  if (!alter) return { kind: "unknown", reason: "not in the statement table" };
  if (hasTopLevelComma(code)) {
    return { kind: "unknown", reason: "an ALTER TABLE with several actions" };
  }
  const action = alter[2]!;

  const add = ADD_COLUMN.exec(action);
  if (add) {
    if (ADD_COLUMN_CONSTRAINT.test(action)) {
      return {
        kind: "unknown",
        reason:
          "an ADD COLUMN carrying an inline constraint or generated value",
      };
    }
    const notNull = NOT_NULL.exec(action);
    if (!notNull || DEFAULT.test(action))
      return { kind: "expand", op: "add-column" };

    // Auto-split. The mask is aligned with the raw text, so offsets found in
    // `code` (the `d` flag's match indices) cut `raw`.
    const actionAt = alter.indices![2]![0];
    const [tableFrom, tableTo] = alter.indices![1]!;
    const [colFrom, colTo] = add.indices![1]!;
    const nnFrom = actionAt + notNull.index;
    const nnTo = nnFrom + notNull[0].length;
    const table = raw.slice(tableFrom, tableTo);
    const column = raw.slice(actionAt + colFrom, actionAt + colTo);
    const expand =
      `${raw.slice(0, nnFrom).trimEnd()}${raw.slice(nnTo)}`.trimEnd();
    return {
      kind: "split",
      op: "add-column-not-null",
      expand,
      contract: `ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`,
    };
  }

  for (const a of ALTER_ACTIONS) if (a.re.test(action)) return a.cls;
  return {
    kind: "unknown",
    reason: "an ALTER TABLE action not in the statement table",
  };
}

/** The phases of one schema migration's statements, each verbatim. */
export interface PhasedStatements {
  expand: string[];
  contract: string[];
}

// Collapse a statement to a short, single-line snippet for error messages.
function snippet(statement: string): string {
  const oneLine = statement.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}

/**
 * Split a generated schema migration into its expand and contract statements.
 * Throws — naming every offending statement — when any is rejected or unknown:
 * a statement this table cannot place must stop generation, never land in a
 * guessed phase.
 */
export function phaseStatements(sql: string): PhasedStatements {
  const out: PhasedStatements = { expand: [], contract: [] };
  const errors: string[] = [];
  for (const stmt of splitStatements(sql)) {
    const cls = classifyStatement(stmt);
    switch (cls.kind) {
      case "expand":
        out.expand.push(stmt.raw);
        break;
      case "contract":
        out.contract.push(stmt.raw);
        break;
      case "split":
        out.expand.push(cls.expand);
        out.contract.push(cls.contract);
        break;
      case "reject":
        errors.push(`  rejected (${cls.reason}):\n    ${snippet(stmt.raw)}`);
        break;
      case "unknown":
        errors.push(
          `  unknown — ${cls.reason}; extend the table in plugins/database/plugins/migrations/core/internal/classify.ts:\n    ${snippet(stmt.raw)}`,
        );
        break;
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `schema migration holds statement(s) the phase classifier cannot place:\n${errors.join("\n")}`,
    );
  }
  return out;
}

/** Join statements into a phase section: one `;`-terminated statement per entry. */
export function renderStatements(statements: readonly string[]): string {
  return statements.map((s) => `${s};`).join("\n");
}
