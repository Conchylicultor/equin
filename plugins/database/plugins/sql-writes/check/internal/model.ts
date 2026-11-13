import type { Node } from "libpg-query";
import type { ProbeOutput, Unwritten } from "./probe-types";

// ── The database the code declares ──────────────────────────────────────────
//
// Two declaration sources, no hand-kept list:
//   - every drizzle table the schema files export (the probe), its derived
//     `updated_at` and generated columns marked unwritten;
//   - the hand-written DDL in source (`CREATE TABLE`, `ALTER TABLE … ADD /
//     DROP / RENAME COLUMN`) — how the imperative public tables
//     (`IMPERATIVE_PUBLIC_TABLES`), temp tables and the like are declared.
// An imperative table whose DDL is generated (a rollup's, from its spec) is
// known by name only: its columns are not checked.

export interface ColumnModel {
  /** An INSERT must name it. */
  readonly required: boolean;
  readonly unwritten: Unwritten | null;
  /** The database fills it when an INSERT leaves it out (a default, identity, generated). */
  readonly filled: boolean;
}

export interface TableModel {
  /** Physical column name → column; null when the columns are not known statically. */
  readonly columns: Map<string, ColumnModel> | null;
  /** Where it is declared, for messages. */
  readonly declaredBy: string;
}

export class SchemaModel {
  private readonly tables = new Map<string, TableModel>();

  static fromProbe(probe: ProbeOutput): SchemaModel {
    const m = new SchemaModel();
    for (const t of probe.tables) {
      m.tables.set(key(t.schema, t.name), {
        columns: new Map(
          t.columns.map((c) => [
            c.name,
            {
              required: c.required,
              unwritten: c.unwritten,
              filled: !c.required,
            },
          ]),
        ),
        declaredBy: t.file,
      });
    }
    for (const name of probe.imperative) {
      if (!m.tables.has(key("public", name)))
        m.tables.set(key("public", name), {
          columns: null,
          declaredBy: "IMPERATIVE_PUBLIC_TABLES",
        });
    }
    return m;
  }

  get(schema: string | undefined, name: string): TableModel | undefined {
    return this.tables.get(key(schema ?? "public", name));
  }

  /**
   * Apply one parsed hand-written DDL statement. CREATE TABLE first (call this
   * for every CREATE before any ALTER), so an ALTER in another file finds it.
   */
  applyCreate(stmt: Node, where: string): void {
    if (!("CreateStmt" in stmt)) return;
    const c = stmt.CreateStmt;
    const name = c.relation?.relname;
    if (!name || /^__h\d+__$/.test(name)) return;
    const k = key(c.relation?.schemaname ?? "public", name);
    const existing = this.tables.get(k);
    if (
      existing &&
      existing.columns === null &&
      existing.declaredBy !== "IMPERATIVE_PUBLIC_TABLES"
    )
      return;
    const columns = existing?.columns ?? new Map<string, ColumnModel>();
    let open = c.tableElts === undefined || (c.inhRelations?.length ?? 0) > 0;
    for (const el of c.tableElts ?? []) {
      if ("ColumnDef" in el) {
        const col = columnDef(el.ColumnDef);
        if (col) columns.set(col.name, col.model);
      } else if ("TableLikeClause" in el) open = true;
      else if ("Constraint" in el) {
        // A table-level PRIMARY KEY makes its columns NOT NULL (they still
        // need a value: required unless a default fills them).
        const con = el.Constraint;
        if (con.contype === "CONSTR_PRIMARY") {
          for (const k2 of con.keys ?? []) {
            const n = "String" in k2 ? k2.String.sval : undefined;
            const col = n ? columns.get(n) : undefined;
            if (n && col && !col.filled)
              columns.set(n, { ...col, required: true });
          }
        }
      }
    }
    this.tables.set(k, {
      columns: open ? null : columns,
      declaredBy: where,
    });
  }

  applyAlter(stmt: Node): void {
    if ("AlterTableStmt" in stmt) {
      const a = stmt.AlterTableStmt;
      const t = a.relation?.relname
        ? this.get(a.relation.schemaname, a.relation.relname)
        : undefined;
      if (!t?.columns) return;
      for (const cmd of a.cmds ?? []) {
        if (!("AlterTableCmd" in cmd)) continue;
        const c = cmd.AlterTableCmd;
        if (c.subtype === "AT_AddColumn" && c.def && "ColumnDef" in c.def) {
          const col = columnDef(c.def.ColumnDef);
          if (col) t.columns.set(col.name, col.model);
        } else if (c.subtype === "AT_DropColumn" && c.name)
          t.columns.delete(c.name);
      }
    } else if ("RenameStmt" in stmt) {
      const r = stmt.RenameStmt;
      if (r.renameType !== "OBJECT_COLUMN" || !r.relation?.relname) return;
      const t = this.get(r.relation.schemaname, r.relation.relname);
      const col = r.subname ? t?.columns?.get(r.subname) : undefined;
      if (!t?.columns || !col || !r.subname || !r.newname) return;
      t.columns.delete(r.subname);
      t.columns.set(r.newname, col);
    }
  }
}

function columnDef(
  d: NonNullable<Extract<Node, { ColumnDef: unknown }>["ColumnDef"]>,
): { name: string; model: ColumnModel } | null {
  if (!d.colname) return null;
  let notNull = d.is_not_null === true;
  let fill = d.raw_default !== undefined || d.identity !== undefined;
  let generated = d.generated !== undefined && d.generated !== "";
  const type = (d.typeName?.names ?? [])
    .map((n) => ("String" in n ? n.String.sval : ""))
    .join(".");
  if (/(^|\.)(small|big)?serial[248]?$/.test(type)) fill = true;
  for (const c of d.constraints ?? []) {
    if (!("Constraint" in c)) continue;
    switch (c.Constraint.contype) {
      case "CONSTR_NOTNULL":
      case "CONSTR_PRIMARY":
        notNull = true;
        break;
      case "CONSTR_DEFAULT":
      case "CONSTR_IDENTITY":
        fill = true;
        break;
      case "CONSTR_GENERATED":
        generated = true;
        break;
      // Every other constraint (CHECK, FOREIGN KEY, UNIQUE, NULL, the
      // deferrable attributes …) says nothing about whether a write must name it.
      case undefined:
      case "CONSTR_NULL":
      case "CONSTR_CHECK":
      case "CONSTR_EXCLUSION":
      case "CONSTR_FOREIGN":
      case "CONSTR_UNIQUE":
      case "CONSTR_ATTR_DEFERRABLE":
      case "CONSTR_ATTR_NOT_DEFERRABLE":
      case "CONSTR_ATTR_DEFERRED":
      case "CONSTR_ATTR_IMMEDIATE":
      case "CONSTR_ATTR_ENFORCED":
      case "CONSTR_ATTR_NOT_ENFORCED":
        break;
    }
  }
  return {
    name: d.colname,
    model: {
      required: notNull && !fill && !generated,
      unwritten: generated ? "generated" : null,
      filled: fill || generated,
    },
  };
}

function key(schema: string, name: string): string {
  return `${schema}.${name}`;
}
