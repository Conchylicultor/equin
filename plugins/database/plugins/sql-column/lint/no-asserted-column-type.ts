/**
 * no-asserted-column-type
 *
 * `text("status").$type<"a" | "b">()` and `jsonb("data").$type<T>()` declare a
 * type nothing produces. Unlike
 * `.mapWith`, `$type` changes **no runtime behaviour at all** — it is purely a
 * type assertion — so a row holding anything else is handed to typed code as if
 * it matched, and every downstream `switch` falls through. It is the
 * `pool.query<Row>(sql)` hole (`sql-rows`) and the ``sql<T>`…` `` hole
 * (`sql-projection`) one layer lower: on the column itself.
 *
 * It is not hypothetical here. Two of this repo's five sites already carry a
 * `tolerantEnum(...)` hedge at the live-state resource boundary — created, per
 * its own doc comment, because "a single stale row would otherwise throw a
 * `ZodError` on the WS push path and blank the entire list". That guard sits on
 * the WIRE, so it protected the browser and nothing else: two server-side
 * readers went straight to the raw column and would have thrown a `TypeError`
 * on a registry lookup for a legacy value the guard exists to absorb.
 *
 * There are two spellings that let you narrow a text column's type WITHOUT a
 * decoder, and both are banned:
 *
 *   text("x").$type<T>()          the assertion
 *   text("x", { enum: [...] })    the type derived from a runtime list
 *
 * The second is better — the type comes from real data rather than from an
 * unrelated type, so it cannot drift — but drizzle emits no CHECK constraint for
 * it, so the stored value is still unverified. Both of its call sites had also
 * duplicated a literal list their own `shared/schemas.ts` already held, so the
 * migration left one `z.enum` feeding the column and the wire schema alike.
 *
 * The sanctioned door is `parsedText(name, schema)` from
 * `@plugins/database/plugins/sql-column/server`, whose `T` is inferred from the
 * schema argument and from nowhere else. It emits byte-identical DDL (drizzle-kit
 * reads `getSQLType()`, which is `"text"`), so adopting it generates no
 * migration.
 *
 * The jsonb tier is the same hole wearing a disguise, and it is in scope now.
 * `jsonb("x").$type<T>()` at least hands back a real JS value — Postgres
 * genuinely decodes the JSON — so what goes unchecked is only the SHAPE, which
 * reads as mostly fine. It is not, and the remedy differs in one way worth
 * saying at the call site: `parsedJson`'s schema NORMALIZES (a `z.object`
 * strips keys it does not declare, on read and on write), so an open bag wants
 * a `z.record` and a closed shape wants a `z.object`. That choice is the whole
 * of porting a site.
 *
 * Scoped by the chain's ROOT: it fires only when the `$type` / config sits on a
 * literal `text(` / `varchar(` / `char(` / `jsonb(` call. A bare `jsonb("x")`
 * with no `$type` stays legal — it reads back `unknown`, which is what the
 * column holds. `defineEntity`'s generic `b.$type()` is out for good: its type
 * came from a field's own `FieldDef` and its fix belonged in the
 * `fields.storage` capability, where it landed; the call no longer exists.
 *
 * NOT type-aware, matching the closest precedents (`no-asserted-sql-type`,
 * `no-unparsed-sql-rows`) — and self-contained by necessity:
 * a contributed rule file is loaded by jiti, which cannot resolve the
 * `@plugins/*` alias, so the rule can name no type from the repo.
 *
 * See research/2026-08-25-database-decoded-columns.md and
 * research/2026-08-26-global-decoded-jsonb-entity-columns.md.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Which decoder a column builder's tier calls for. The two tiers differ only in
 * their remedy, so the rule keys the message off this rather than off the
 * builder name — a fourth text-family builder needs no second branch.
 */
type ColumnTier = "text" | "json";

/** The drizzle pg-core builders whose narrowed type must come from a decoder. */
const COLUMN_FACTORIES = new Map<string, ColumnTier>([
  ["text", "text"],
  ["varchar", "text"],
  ["char", "text"],
  ["jsonb", "json"],
]);

/**
 * ``text("x")`` / ``jsonb("x")`` — a bare call to one of those builders, and
 * which tier it belongs to. `null` when it is not one, deliberately rather than
 * a type predicate: narrowing `node` on the false branch would leave the `$type`
 * check reading `.callee` off `never`.
 */
function columnTierOf(node: TSESTree.Node): ColumnTier | null {
  if (node.type !== "CallExpression") return null;
  if (node.callee.type !== "Identifier") return null;
  return COLUMN_FACTORIES.get(node.callee.name) ?? null;
}

/**
 * Is `expr` a column builder, possibly behind a chain of calls on it —
 * `text("x").notNull()`, `jsonb("x").default({})`? Only such a chain can carry
 * drizzle's `$type`, so this keeps the rule off every unrelated `.$type<T>()`.
 * Answers with the ROOT's tier, which is what picks the remedy.
 */
function rootColumnTier(expr: TSESTree.Node): ColumnTier | null {
  const own = columnTierOf(expr);
  if (own) return own;
  if (expr.type === "TSNonNullExpression" || expr.type === "TSAsExpression") {
    return rootColumnTier(expr.expression);
  }
  if (expr.type === "CallExpression") return rootColumnTier(expr.callee);
  if (expr.type === "MemberExpression") return rootColumnTier(expr.object);
  return null;
}

/**
 * Explicit type arguments. typescript-eslint renamed `typeParameters` →
 * `typeArguments` on call expressions; the repo is on v8 but the rule stays
 * readable under both.
 */
function hasTypeArguments(node: TSESTree.CallExpression): boolean {
  const withBoth = node as unknown as {
    typeArguments?: unknown;
    typeParameters?: unknown;
  };
  return (
    withBoth.typeArguments !== undefined ||
    withBoth.typeParameters !== undefined
  );
}

/** The static name of a member property: `a.$type` and `a["$type"]` both → "$type". */
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

/** `{ enum: [...] }` as the builder's config argument. */
function hasEnumConfig(node: TSESTree.CallExpression): boolean {
  return node.arguments.some(
    (arg) =>
      arg.type === "ObjectExpression" &&
      arg.properties.some(
        (prop) =>
          prop.type === "Property" &&
          !prop.computed &&
          ((prop.key.type === "Identifier" && prop.key.name === "enum") ||
            (prop.key.type === "Literal" && prop.key.value === "enum")),
      ),
  );
}

const TEXT_REMEDY =
  "Use `parsedText(name, schema)` from `@plugins/database/plugins/sql-column/server`: it builds the " +
  "same `text` column through drizzle's `customType`, with the schema as the real `fromDriver` / " +
  "`toDriver` decoder, and infers the column's type from that schema alone — so the type cannot be " +
  "chosen independently of what runs. Pass the strict `z.enum` when the value set is closed and " +
  "private to one engine (an outsider is a bug, so it throws), or a `tolerantEnum(strict, normalize, " +
  "report)` when ids get renamed and old rows outlive them (it normalizes and fires the deduped " +
  "corruption report instead). The generated DDL is byte-identical to `text(...)` — `getSQLType()` is " +
  '"text" — so adopting it produces no migration. ' +
  "See research/2026-08-25-database-decoded-columns.md.";

const JSON_REMEDY =
  "Use `parsedJson(name, schema)` from `@plugins/database/plugins/sql-column/server`: it builds the " +
  "same `jsonb` column through drizzle's `customType`, with the schema as the real `fromDriver` / " +
  "`toDriver` decoder, and infers the column's type from that schema alone. One decision to make: it " +
  "NORMALIZES as well as checks, because a `z.object` strips keys it does not declare, in both " +
  "directions. So an open per-producer bag takes `z.record(z.string(), z.unknown())`, which verifies " +
  "the value really is a non-null object — all `Record<string, unknown>` ever claimed — and keeps " +
  "every key; a closed shape takes its `z.object`, which is what makes the declared type true rather " +
  "than merely asserted. Cost is the SCHEMA's depth, not the payload's size: the largest jsonb value " +
  "in this repo (avg 123 KB) decodes in 1.7 µs against its own shallow schema. The generated DDL is " +
  'byte-identical to `jsonb(...)` — `getSQLType()` is "jsonb", and `.default()` is untouched — so ' +
  "adopting it produces no migration. A column that really is arbitrary JSON keeps a bare `jsonb(x)` " +
  "and its honest `unknown`. " +
  "See research/2026-08-26-database-decoded-jsonb-hand-written-columns.md.";

export default createRule({
  name: "no-asserted-column-type",
  meta: {
    type: "problem",
    docs: {
      description:
        "a column's narrowed type must come from a decoder — `parsedText` / `parsedJson`, never `$type<T>()` or an `enum` config",
    },
    schema: [],
    messages: {
      assertedColumnType:
        "This `.$type<…>()` on a text column declares a type nothing produces. `$type` changes NO runtime " +
        "behaviour at all — it is purely a type assertion, unlike `.mapWith`, which is why the projection " +
        "guardrail does not reach here. A row written by an older schema version, by hand, or by a worktree " +
        "on different code reads back as a well-typed value that is not in the union, and every downstream " +
        "`switch` falls through. It has already cost this repo two `tolerantEnum` hedges at the live-state " +
        "resource boundary — which protected the browser and left two server-side readers throwing a " +
        "`TypeError` on a registry lookup. " +
        TEXT_REMEDY,
      enumColumnConfig:
        "This `{ enum: [...] }` config derives the column's type from a runtime list, which is better than " +
        "`$type<T>()` — the type cannot drift from an unrelated type — but drizzle emits no CHECK constraint " +
        "for it, so the stored value is still unverified and a row outside the list still reads back as a " +
        "well-typed member. " +
        "It is also where the same literal list tends to get duplicated: both of this repo's call sites " +
        "spelled the set twice, once here and once in the plugin's own `shared/schemas.ts` wire schema, free " +
        "to drift apart. One `z.enum` feeding both is the fix in either direction. " +
        TEXT_REMEDY,
      assertedJsonColumnType:
        "This `.$type<…>()` on a jsonb column declares a SHAPE nothing produces. Postgres genuinely " +
        "decodes the JSON, so the value really is a JS value — which is what makes this read as safer " +
        "than the text tier and is exactly why it is not: `$type` changes NO runtime behaviour at all, " +
        "so a row written by an older schema version, by hand, or by a worktree on different code is " +
        "handed to typed code as a well-typed value of a shape it does not have, and nothing in either " +
        "direction ever looks. " +
        JSON_REMEDY,
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const ownTier = columnTierOf(node);
        if (ownTier) {
          // The `{ enum: [...] }` config is a text-family spelling; `jsonb` has
          // no such argument, so there is nothing to report on a bare one.
          if (ownTier === "text" && hasEnumConfig(node)) {
            context.report({ node, messageId: "enumColumnConfig" });
          }
          return;
        }
        if (!hasTypeArguments(node)) return;
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (propertyName(callee) !== "$type") return;
        const tier = rootColumnTier(callee.object);
        if (!tier) return;
        context.report({
          node,
          messageId:
            tier === "json" ? "assertedJsonColumnType" : "assertedColumnType",
        });
      },
    };
  },
});
