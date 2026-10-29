/**
 * no-asserted-sql-type
 *
 * ``sql<T>`…` `` in a drizzle projection declares a type nothing produces. A raw
 * SQL expression carries `noopDecoder` — the identity function — so whatever the
 * driver decoded is handed to typed code as if it matched `T`. `tsc` is
 * satisfied, the code reads as typed, and a mismatch surfaces as WRONG
 * BEHAVIOUR, never as an error. It is the `pool.query<Row>(sql)` hole
 * (`sql-rows`) one layer down, inside the row rather than around it.
 *
 * It is not hypothetical. `sql<Date | null>` over a `timestamptz` column really
 * delivers a `string`: `drizzle-orm/node-postgres` overrides the pg type parsers
 * so TIMESTAMPTZ / TIMESTAMP / DATE / INTERVAL arrive as their raw string,
 * leaving the mapping to drizzle's own column types — which a raw projection
 * does not have. Three of this repo's projections said `Date` and held a string;
 * two consumers had grown a `const toDate = (v) => v instanceof Date ? v : new
 * Date(v)` hedge around it, applied to every timestamp they touched.
 *
 * There is nothing to add for the *positive* case, which is what makes this
 * cheap: drop the type argument and an unmapped projection is `SQL<unknown>` —
 * honest, and unusable downstream without handling it. `tsc` already demands a
 * decoder the moment you want a usable type. The only thing that has to go is
 * the spelling that lets you name a type WITHOUT one, and there are two of them:
 *
 *   sql<T>`…`              the type argument on the tag
 *   sql`…`.as<T>("alias")  drizzle's deprecated SQL.as<TData>(), identical
 *
 * The second has zero occurrences in this repo today and is banned anyway, for
 * the reason `no-unparsed-sql-rows` keys on "rows were read" rather than "a
 * generic was written": a rule that closed only the first would push the next
 * author onto a spelling that is exactly as unsafe.
 *
 * No exemption by shape. ``sql<string>`count(*)` `` is true only by luck (int8
 * decodes to a string, int4 does not), and `.mapWith(String)` says the same
 * thing while making it true.
 *
 * NOT type-aware, matching the closest precedents (`no-unparsed-sql-rows`,
 * `no-raw-bun-spawn`) — and self-contained by necessity: a
 * contributed rule file is loaded by jiti, which cannot resolve the `@plugins/*`
 * alias, so the rule can name no type from the repo.
 *
 * See research/2026-08-25-database-mapped-sql-projections.md.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** The tag identifier drizzle's SQL template is spelled with. */
const SQL_TAG = "sql";

/** The static name of a member property: `a.as` and `a["as"]` both → "as". */
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
 * Explicit type arguments, under either spelling. typescript-eslint renamed
 * `typeParameters` → `typeArguments` on call / tagged-template expressions; the
 * repo is on v8 but the rule stays readable under both.
 */
function hasTypeArguments(
  node: TSESTree.CallExpression | TSESTree.TaggedTemplateExpression,
): boolean {
  const withBoth = node as unknown as {
    typeArguments?: unknown;
    typeParameters?: unknown;
  };
  return (
    withBoth.typeArguments !== undefined ||
    withBoth.typeParameters !== undefined
  );
}

/** ``sql`…` `` — the drizzle template, tagged by a bare `sql` identifier. */
function isSqlTemplate(node: TSESTree.Node): boolean {
  return (
    node.type === "TaggedTemplateExpression" &&
    node.tag.type === "Identifier" &&
    node.tag.name === SQL_TAG
  );
}

/**
 * Is `expr` a ``sql`…` `` template, possibly behind a chain of calls on it —
 * ``sql`…`.mapWith(x)``, ``sql`…`.inlineParams()``? Only such a chain can reach
 * drizzle's `SQL.as<TData>()`, so this keeps the `.as<T>()` half of the rule off
 * every unrelated `.as<T>()` in the language.
 */
function rootsInSqlTemplate(expr: TSESTree.Node): boolean {
  if (isSqlTemplate(expr)) return true;
  if (expr.type === "TSNonNullExpression" || expr.type === "TSAsExpression") {
    return rootsInSqlTemplate(expr.expression);
  }
  if (expr.type === "CallExpression") return rootsInSqlTemplate(expr.callee);
  if (expr.type === "MemberExpression") return rootsInSqlTemplate(expr.object);
  return false;
}

const REMEDY =
  "Drop the type argument and add `.mapWith(…)`: drizzle computes the resulting " +
  "type FROM the decoder (`mapWith<D>(d): SQL<GetDecoderResult<D>>`), so it can no " +
  "longer be chosen independently of what actually runs. Pick the decoder that " +
  "makes the type true by construction — `.mapWith(thatColumn)` when the " +
  "expression is a column or an aggregate over one (`nullable(thatColumn)` when it " +
  "can be NULL), `.mapWith(parsed(schema, label))` for a composite shape (an " +
  "array, a JSON object, a string-literal union), `.mapWith(Boolean)` / `Number` / " +
  "`String` for a scalar whose pg type is certain. `nullable` and `parsed` come " +
  "from `@plugins/database/plugins/sql-projection/server`. With no type argument " +
  "and no decoder the projection is `SQL<unknown>`, which is honest — and is what " +
  "you want for a `jsonb ->` blob nobody has checked yet. " +
  "See research/2026-08-25-database-mapped-sql-projections.md.";

export default createRule({
  name: "no-asserted-sql-type",
  meta: {
    type: "problem",
    docs: {
      description:
        "a raw SQL projection's type must come from a decoder — `.mapWith(…)`, never a `sql<T>` type argument",
    },
    schema: [],
    messages: {
      assertedSqlType:
        "This `sql<T>` declares a type nothing produces. A raw SQL expression carries drizzle's " +
        "`noopDecoder` — the identity function — so whatever the driver decoded is handed to typed code as if " +
        "it matched `T`. `tsc` is satisfied and a mismatch surfaces as wrong behaviour, never as an error. " +
        "It is the `pool.query<Row>(sql)` hole one layer down, inside the row rather than around it. " +
        "It has already bitten here: `drizzle-orm/node-postgres` overrides the pg type parsers so timestamptz " +
        "arrives as a raw STRING (drizzle's own column types are what turn it into a `Date`, and a raw " +
        "projection has none) — three projections in this repo said `Date | null` and held `string | null`, " +
        "and two consumers had grown an `instanceof Date` hedge around every timestamp they touched. " +
        REMEDY,
      assertedSqlAlias:
        "This `.as<T>(…)` on a `sql` expression is drizzle's deprecated `SQL.as<TData>()` — the same pure " +
        "assertion as `sql<T>`, spelled one call later, and with the same consequence: the projection's type " +
        "is written by hand while its decoder stays the identity function. " +
        "It is banned even though nothing writes it today, for the reason `no-unparsed-sql-rows` keys on " +
        '"rows were read" rather than "a generic was written" — closing only one spelling pushes the next ' +
        'author onto one that is exactly as unsafe. `.as("alias")` with no type argument is the alias, is ' +
        "fine, and is unaffected. " +
        REMEDY,
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression) {
        if (!isSqlTemplate(node)) return;
        if (!hasTypeArguments(node)) return;
        context.report({ node, messageId: "assertedSqlType" });
      },

      CallExpression(node: TSESTree.CallExpression) {
        if (!hasTypeArguments(node)) return;
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (propertyName(callee) !== "as") return;
        if (!rootsInSqlTemplate(callee.object)) return;
        context.report({ node, messageId: "assertedSqlAlias" });
      },
    };
  },
});
