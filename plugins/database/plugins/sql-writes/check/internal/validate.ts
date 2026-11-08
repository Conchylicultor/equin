import type { Node, RangeVar, ResTarget } from "libpg-query";
import type { SchemaModel, TableModel } from "./model";
import { PLACEHOLDER } from "./statements";

// ── Every write of a parsed statement, against the declared schema ──────────
//
// Walks the whole tree, so a write inside a CTE, a subquery or a MERGE is found
// like a top-level one. For each INSERT / UPDATE / DELETE / MERGE:
//   - its target table must be declared (`unknown-table`), spelled in source
//     (a placeholder there is `dynamic`);
//   - every column it writes — the INSERT list, a SET list, ON CONFLICT's
//     target and SET, MERGE's actions — must exist (`unknown-column`), be spelled
//     (`dynamic`), and be writable: never a derived `updated_at` or a generated
//     column (`derived`);
//   - an INSERT must name its columns (`positional-insert`) and every required
//     one — NOT NULL, nothing in the database fills it (`missing-required`);
//   - a column its WHERE or RETURNING reads off the target (qualified by the
//     target's name or alias, or unqualified where the statement reads no other
//     table) must exist (`unknown-column`).
// Function and DO bodies are strings to this parser and are not looked into.

export type IssueKind =
  | "dynamic"
  | "unknown-table"
  | "unknown-column"
  | "positional-insert"
  | "missing-required"
  | "derived";

export interface Issue {
  readonly kind: IssueKind;
  readonly message: string;
}

/** Whether any statement in `stmts` writes (so a parsed literal is a write site). */
export function writesIn(stmts: readonly Node[]): number {
  let n = 0;
  walk(stmts, (node) => {
    if (
      "InsertStmt" in node ||
      "UpdateStmt" in node ||
      "DeleteStmt" in node ||
      "MergeStmt" in node
    )
      n++;
  });
  return n;
}

export function validateStatements(
  stmts: readonly Node[],
  model: SchemaModel,
): Issue[] {
  const issues: Issue[] = [];
  walk(stmts, (node) => {
    if ("InsertStmt" in node) {
      const s = node.InsertStmt;
      const t = target(s.relation, "INSERT INTO", model, issues);
      if (!t) return;
      const cols = resTargets(s.cols);
      if (cols.length === 0 && s.selectStmt !== undefined)
        add(
          issues,
          "positional-insert",
          `${t.label}: an INSERT without a column list (a column added or reordered changes what it writes)`,
        );
      written(t, cols, "INSERT", issues, "insert");
      // A positional INSERT names no column: reported as that, not as missing
      // ones. `DEFAULT VALUES` (no column list, no rows) names none either.
      const positional = cols.length === 0 && s.selectStmt !== undefined;
      if (
        t.model.columns &&
        !positional &&
        !cols.some((c) => isPlaceholder(c.name))
      ) {
        const named = new Set(cols.map((c) => c.name));
        const missing = [...t.model.columns]
          .filter(([n, c]) => c.required && !named.has(n))
          .map(([n]) => n);
        if (missing.length > 0)
          add(
            issues,
            "missing-required",
            `${t.label}: the INSERT leaves out required column(s) ${missing.join(", ")} (NOT NULL, no database default)`,
          );
      }
      const oc = s.onConflictClause;
      if (oc) {
        const inferred = (oc.infer?.indexElems ?? []).flatMap((e) =>
          "IndexElem" in e && e.IndexElem.name ? [e.IndexElem.name] : [],
        );
        exist(t, inferred, "ON CONFLICT target", issues);
        written(
          t,
          resTargets(oc.targetList),
          "ON CONFLICT DO UPDATE SET",
          issues,
          "update",
        );
      }
      reads(t, s.relation, [s.returningClause?.exprs], issues, true);
    } else if ("UpdateStmt" in node) {
      const s = node.UpdateStmt;
      const t = target(s.relation, "UPDATE", model, issues);
      if (!t) return;
      written(t, resTargets(s.targetList), "UPDATE SET", issues, "update");
      reads(
        t,
        s.relation,
        [s.whereClause, s.returningClause?.exprs],
        issues,
        (s.fromClause?.length ?? 0) === 0,
      );
    } else if ("DeleteStmt" in node) {
      const s = node.DeleteStmt;
      const t = target(s.relation, "DELETE FROM", model, issues);
      if (!t) return;
      reads(
        t,
        s.relation,
        [s.whereClause, s.returningClause?.exprs],
        issues,
        (s.usingClause?.length ?? 0) === 0,
      );
    } else if ("MergeStmt" in node) {
      const s = node.MergeStmt;
      const t = target(s.relation, "MERGE INTO", model, issues);
      if (!t) return;
      for (const w of s.mergeWhenClauses ?? []) {
        if (!("MergeWhenClause" in w)) continue;
        const c = w.MergeWhenClause;
        if (c.commandType === "CMD_UPDATE")
          written(
            t,
            resTargets(c.targetList),
            "MERGE UPDATE SET",
            issues,
            "update",
          );
        if (c.commandType === "CMD_INSERT") {
          written(
            t,
            resTargets(c.targetList),
            "MERGE INSERT",
            issues,
            "insert",
          );
        }
      }
    }
  });
  return issues;
}

interface Target {
  readonly label: string;
  readonly model: TableModel;
}

function target(
  rel: RangeVar | undefined,
  verb: string,
  model: SchemaModel,
  issues: Issue[],
): Target | null {
  const name = rel?.relname;
  if (!rel || !name) return null;
  if (isPlaceholder(name)) {
    add(
      issues,
      "dynamic",
      `${verb} a table the source does not spell (an interpolated value)`,
    );
    return null;
  }
  const label = rel.schemaname ? `${rel.schemaname}.${name}` : name;
  const t = model.get(rel.schemaname, name);
  if (!t) {
    add(
      issues,
      "unknown-table",
      `${verb} ${label}: no such table is declared (no drizzle schema table, no hand-written table DDL)`,
    );
    return null;
  }
  return { label, model: t };
}

/**
 * `as`: a derived `updated_at` is refused in an UPDATE position only — its
 * trigger is BEFORE UPDATE, and an INSERT naming it writes history (the raw
 * twin of `insertWithUpdatedAt`). A generated column is refused in both.
 */
function written(
  t: Target,
  cols: readonly ResTarget[],
  where: string,
  issues: Issue[],
  as: "insert" | "update",
): void {
  for (const c of cols) {
    const name = c.name;
    if (!name) continue;
    if (isPlaceholder(name)) {
      add(
        issues,
        "dynamic",
        `${t.label}: ${where} writes columns the source does not spell (an interpolated list or name)`,
      );
      continue;
    }
    const col = t.model.columns?.get(name);
    if (!t.model.columns) continue;
    if (!col) {
      add(
        issues,
        "unknown-column",
        `${t.label}: ${where} writes ${name}, which is not a column of it`,
      );
      continue;
    }
    if (col.unwritten === "derived-updated-at" && as === "update")
      add(
        issues,
        "derived",
        `${t.label}: ${where} writes ${name}, which is derived (its touchedBy trigger sets it and refuses an explicit write)`,
      );
    else if (col.unwritten === "generated")
      add(
        issues,
        "derived",
        `${t.label}: ${where} writes ${name}, a generated column`,
      );
  }
}

function exist(
  t: Target,
  names: readonly string[],
  where: string,
  issues: Issue[],
): void {
  if (!t.model.columns) return;
  for (const n of names) {
    if (isPlaceholder(n)) continue;
    if (!t.model.columns.has(n))
      add(
        issues,
        "unknown-column",
        `${t.label}: ${where} names ${n}, which is not a column of it`,
      );
  }
}

/**
 * Columns read off the target in `exprs`: qualified by its alias or name, or —
 * when `unqualifiedIsTarget` (the statement reads no other table) —
 * unqualified, outside subqueries (which have scopes of their own).
 */
function reads(
  t: Target,
  rel: RangeVar | undefined,
  exprs: readonly (Node | readonly Node[] | undefined)[],
  issues: Issue[],
  unqualifiedIsTarget: boolean,
): void {
  if (!t.model.columns || !rel?.relname) return;
  const alias = rel.alias?.aliasname ?? rel.relname;
  const names: string[] = [];
  const visit = (node: unknown, top: boolean): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n, top);
      return;
    }
    if (!isObject(node)) return;
    if ("ColumnRef" in node) {
      const fields = ((node.ColumnRef as { fields?: Node[] }).fields ?? []).map(
        (f) => ("String" in f ? f.String.sval : null),
      );
      if (fields.length === 2 && fields[0] === alias && fields[1])
        names.push(fields[1]);
      if (fields.length === 1 && fields[0] && top && unqualifiedIsTarget)
        names.push(fields[0]);
      return;
    }
    const sub =
      "SubLink" in node || "SelectStmt" in node || "RangeSubselect" in node;
    // A subquery whose FROM re-binds the target's alias: its `alias.col` is not ours.
    if ("SelectStmt" in node && rebinds(node.SelectStmt, alias)) return;
    for (const v of Object.values(node)) visit(v, top && !sub);
  };
  for (const e of exprs) visit(e, true);
  // `excluded` and placeholders are not the target's columns.
  exist(
    t,
    names.filter((n) => !SYSTEM_COLUMNS.has(n)),
    "a read (WHERE / RETURNING)",
    issues,
  );
}

// Every table's system columns (and `excluded`, ON CONFLICT's proposed row).
const SYSTEM_COLUMNS = new Set([
  "xmin",
  "xmax",
  "cmin",
  "cmax",
  "ctid",
  "tableoid",
  "excluded",
]);

/** Whether a SELECT's FROM binds `alias` itself (a table, its alias, a subquery alias). */
function rebinds(select: unknown, alias: string): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (!isObject(v)) return;
    if ("RangeVar" in v) {
      const r = v.RangeVar as RangeVar;
      if ((r.alias?.aliasname ?? r.relname) === alias) found = true;
    } else if ("RangeSubselect" in v) {
      const r = v.RangeSubselect as { alias?: { aliasname?: string } };
      if (r.alias?.aliasname === alias) found = true;
    } else if ("JoinExpr" in v) {
      const j = v.JoinExpr as { larg?: unknown; rarg?: unknown };
      visit(j.larg);
      visit(j.rarg);
    }
  };
  visit(isObject(select) ? select.fromClause : undefined);
  return found;
}

function resTargets(list: readonly Node[] | undefined): ResTarget[] {
  return (list ?? []).flatMap((n) => ("ResTarget" in n ? [n.ResTarget] : []));
}

const isPlaceholder = (name: string | undefined): boolean =>
  name !== undefined && PLACEHOLDER.test(name);

function add(issues: Issue[], kind: IssueKind, message: string): void {
  if (!issues.some((i) => i.message === message))
    issues.push({ kind, message });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Every node of the tree, pre-order (a node is a one-key `{ Kind: {...} }`). */
function walk(root: unknown, fn: (node: Node) => void): void {
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (!isObject(v)) return;
    const keys = Object.keys(v);
    if (keys.length === 1 && /^[A-Z]/.test(keys[0] as string)) fn(v as Node);
    for (const x of Object.values(v)) visit(x);
  };
  visit(root);
}
