/**
 * no-unparsed-sql-rows
 *
 * `pool.query<Row>(sql)` declares a row type that nothing verifies. The generic
 * is a pure assertion: whatever `pg` decodes is handed to typed code as if it
 * matched. `tsc` is satisfied, the code reads as typed, and a mismatch surfaces
 * as WRONG BEHAVIOUR, never as an error.
 *
 * That already cost a real incident. A fork-plan query used `array_agg(relname)`,
 * which produces `name[]` (OID 1003). `pg` has no decoder registered for that
 * OID, so the column arrived as the raw Postgres literal STRING
 * `"{_private_jobs,migrations,…}"` while its declared type said `string[]`.
 * Downstream, `for (const t of tables)` walked the string one character at a
 * time and `tables.includes(x)` silently became substring matching. The result:
 * a database fork that emitted sixty `pg_dump` patterns matching nothing,
 * copied a whole schema it was meant to empty, and reported success. No check,
 * no lint rule, no test caught it — the unit tests build their input by hand,
 * so they can only ever see a well-formed row.
 *
 * The exposure is not the explicit generic. Three spellings, all unchecked:
 *
 *   pool.query<Row>(sql)                    asserts the whole row
 *   db.execute<Row>(sql`…`)                 same, via drizzle's raw escape hatch
 *   const r = await pool.query(sql); r.rows asserts NOTHING — `rows` is `any[]`
 *
 * The third is *worse*: `any` accepts every downstream misuse silently. So a
 * rule that banned only the generic would push authors onto the strictly less
 * safe form. What is reported is therefore "rows were read at all", not "a type
 * argument was written":
 *
 *   (a) the call carries explicit type arguments — `.query<T>(…)` / `.execute<T>(…)`, OR
 *   (b) the call's result is read for rows — `(await c).rows`,
 *       `const { rows } = await c`, `const r = await c; … r.rows` (resolved
 *       through scope analysis on the declarator's variable references, because
 *       the two-statement shape is the common one in this repo), or
 *       `c.then((r) => r.rows)`.
 *
 * conjoined with "the callee is a member named `query` or `execute`". That
 * conjunction is what keeps false positives near zero without a type check.
 *
 * DDL/DML that never reads `.rows` — `pool.query(ddl)`,
 * `db.execute(sql`DELETE …`)` — is untouched, which is what keeps the change
 * proportionate: ~120 `.query(`/`.execute(` call sites exist, but only the
 * row-reading subset has to move.
 *
 * NOT type-aware, matching the closest precedents (`no-raw-bun-spawn`,
 * `no-adhoc-file-sink`) — and self-contained by necessity:
 * a contributed rule file is loaded by jiti, which cannot resolve the
 * `@plugins/*` alias, so the rule can name no type from the repo.
 *
 * See research/2026-08-23-database-parsed-sql-rows.md.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** Callee property names whose result is a raw SQL result object. */
const SQL_CALL_NAMES = new Set(["query", "execute"]);

/** The static name of a member property: `a.rows` and `a["rows"]` both → "rows". */
function propertyName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return null;
}

/**
 * Type arguments on a call, under either spelling. typescript-eslint renamed
 * `typeParameters` → `typeArguments` on call/new expressions; the repo is on v8
 * (`typeArguments`), but reading both keeps the rule correct if the parser
 * version moves under it — a rule that silently stopped seeing `.query<T>(…)`
 * would be worse than one that never saw it.
 */
function hasTypeArguments(node: TSESTree.CallExpression): boolean {
  const withLegacy = node as TSESTree.CallExpression & {
    typeParameters?: { params: unknown[] };
  };
  const args = node.typeArguments ?? withLegacy.typeParameters;
  return (args?.params.length ?? 0) > 0;
}

/** Unwrap the wrappers that pass a value through unchanged. */
function unwrapParent(node: TSESTree.Node): TSESTree.Node | null {
  const parent = node.parent;
  if (!parent) return null;
  if (
    parent.type === "ChainExpression" ||
    parent.type === "TSNonNullExpression" ||
    parent.type === "TSAsExpression" ||
    parent.type === "TSSatisfiesExpression" ||
    parent.type === "AwaitExpression"
  ) {
    return parent;
  }
  return null;
}

/** Does this binding pattern pull a `rows` property out? */
function patternDestructuresRows(pattern: TSESTree.Node): boolean {
  if (pattern.type !== "ObjectPattern") return false;
  return pattern.properties.some((p) => {
    if (p.type !== "Property") return false;
    if (!p.computed && p.key.type === "Identifier")
      return p.key.name === "rows";
    if (p.key.type === "Literal") return p.key.value === "rows";
    return false;
  });
}

/** Is this identifier the object of a `<id>.rows` read? */
function isRowsMemberObject(identifier: TSESTree.Node): boolean {
  const parent = identifier.parent;
  return (
    parent?.type === "MemberExpression" &&
    parent.object === identifier &&
    propertyName(parent) === "rows"
  );
}

/**
 * Every later use of a variable the result was bound to, asked: does any of
 * them reach `rows`? This is the shape the repo actually writes —
 * `const r = await pool.query(sql); … return r.rows;` — so a rule that only
 * matched `(await …).rows` would miss the majority of real sites.
 *
 * Two ways a reference reaches rows: directly (`r.rows`) and one hop through a
 * later destructure (`const { rows } = r`).
 */
function referencesReadRows(
  declarator: TSESTree.VariableDeclarator,
  sourceCode: TSESLint.SourceCode,
): boolean {
  for (const variable of sourceCode.getDeclaredVariables(declarator)) {
    for (const reference of variable.references) {
      const identifier = reference.identifier;
      if (isRowsMemberObject(identifier)) return true;
      const parent = identifier.parent;
      if (
        parent.type === "VariableDeclarator" &&
        parent.init === identifier &&
        patternDestructuresRows(parent.id)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** `c.then((r) => r.rows)` — the callback's first param reaches rows. */
function thenCallbackReadsRows(call: TSESTree.CallExpression): boolean {
  const callback = call.arguments[0];
  if (
    callback?.type !== "ArrowFunctionExpression" &&
    callback?.type !== "FunctionExpression"
  ) {
    return false;
  }
  const param = callback.params[0];
  if (!param) return false;
  if (patternDestructuresRows(param)) return true;
  if (param.type !== "Identifier") return false;
  // Coarse on purpose: any `<param>.rows` anywhere in the callback body counts.
  return containsRowsReadOn(callback.body, param.name);
}

function containsRowsReadOn(node: TSESTree.Node, name: string): boolean {
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (
      n.type === "MemberExpression" &&
      n.object.type === "Identifier" &&
      n.object.name === name &&
      propertyName(n) === "rows"
    ) {
      found = true;
    }
    return !found;
  });
  return found;
}

/** Pre-order walk over every child node; `visit` returns false to prune. */
function walk(node: TSESTree.Node, visit: (n: TSESTree.Node) => boolean): void {
  if (!visit(node)) return;
  for (const key of Object.keys(node) as (keyof TSESTree.Node)[]) {
    if (key === "parent") continue;
    const value = node[key] as unknown;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isNode(child)) walk(child, visit);
      }
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

function isNode(value: unknown): value is TSESTree.Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export default createRule({
  name: "no-unparsed-sql-rows",
  meta: {
    type: "problem",
    docs: {
      description:
        "raw SQL rows must be parsed, not asserted — route row-reading " +
        "`.query(…)` / `.execute(…)` through sql-rows' queryRows / executeRows",
    },
    schema: [],
    messages: {
      unparsedSqlRows:
        "This raw SQL result is consumed as if its declared shape had been checked, and nothing checks it. " +
        "A type argument — `.query<Row>(sql)`, `.execute<Row>(q)` — is a pure assertion: whatever `pg` decodes " +
        "is handed to typed code as if it matched, so `tsc` is satisfied and a mismatch surfaces as wrong " +
        "behaviour, never as an error. The bare form is worse, not safer: `result.rows` is `any[]`, which " +
        "accepts every downstream misuse silently. " +
        "This already cost a real incident: a fork-plan query used `array_agg(relname)`, which produces `name[]` " +
        "(OID 1003); `pg` has no decoder registered for that OID, so the raw Postgres literal STRING " +
        '"{_private_jobs,migrations,…}" arrived where `string[]` was declared. `for (const t of tables)` then ' +
        "walked that string one character at a time and `tables.includes(x)` silently became substring matching — " +
        "the database fork emitted sixty `pg_dump` patterns matching nothing, copied a whole schema it was meant " +
        "to empty, and reported success. " +
        "Route the read through `queryRows` / `executeRows` / `queryOne` / `executeOne` from " +
        "`@plugins/database/plugins/sql-rows/core`. They take a `z.ZodType` and fail loudly at the boundary, " +
        "naming the column, the value that actually arrived and the pg type OID behind it — which turns a " +
        "multi-hour 'why is my fork empty' into a one-line SQL cast. " +
        "DDL/DML that never reads `.rows` is fine and is not what this rule targets: `pool.query(ddl)` and " +
        "`db.execute(sql`DELETE …`)` stay exactly as they are. " +
        "A genuine exception gets an entry in its plugin's `exempt/index.ts` with a written justification, never an " +
        "inline eslint-disable. See research/2026-08-23-database-parsed-sql-rows.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    /**
     * Is the value of `expr` read for rows? Walks up through the wrappers that
     * pass a value through unchanged (`await`, `?.`, `!`, `as`) and then judges
     * the one parent that actually consumes it.
     */
    function readsRows(expr: TSESTree.Node): boolean {
      const passthrough = unwrapParent(expr);
      if (passthrough) return readsRows(passthrough);

      const parent = expr.parent;
      if (!parent) return false;

      if (parent.type === "MemberExpression" && parent.object === expr) {
        const name = propertyName(parent);
        if (name === "rows") return true;
        if (
          name === "then" &&
          parent.parent.type === "CallExpression" &&
          parent.parent.callee === parent
        ) {
          return thenCallbackReadsRows(parent.parent);
        }
        return false;
      }

      if (parent.type === "VariableDeclarator" && parent.init === expr) {
        if (patternDestructuresRows(parent.id)) return true;
        if (parent.id.type !== "Identifier") return false;
        return referencesReadRows(parent, context.sourceCode);
      }

      return false;
    }

    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee =
          node.callee.type === "TSNonNullExpression"
            ? node.callee.expression
            : node.callee;
        if (callee.type !== "MemberExpression") return;
        const name = propertyName(callee);
        if (name === null || !SQL_CALL_NAMES.has(name)) return;

        if (!hasTypeArguments(node) && !readsRows(node)) return;

        context.report({ node, messageId: "unparsedSqlRows" });
      },
    };
  },
});
