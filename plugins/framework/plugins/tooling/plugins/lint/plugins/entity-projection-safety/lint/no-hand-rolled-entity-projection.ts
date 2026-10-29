import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

/**
 * no-hand-rolled-entity-projection
 *
 * Tripwire for a specific footgun: a live-state resource loader that hand-writes
 * an IDENTITY row projection over a drizzle `db.select()` —
 *
 *   loader: async () => {
 *     const rows = await db.select().from(_myTable);
 *     return rows.map((r) => ({ id: r.id, name: r.name }));   // <-- flagged
 *   }
 *
 * The hand-written object silently drops any column you forget: add a column to
 * the table and the wire schema keeps returning the old shape, with NO tsc error
 * (the loader's return type IS the hand-written object). This is the bug that
 * dropped `recentSamples` from `slow_ops`. The fix is `defineEntity`
 * (@plugins/infra/plugins/entities/server): derive the pgTable AND the zod wire
 * schema from one field record, then return `db.select()` rows verbatim. For a
 * 1:1 side-table the same fix is `defineExtensionShape` (entity-extensions/core,
 * browser-safe) + `defineExtension` (entity-extensions/server): the handle IS an
 * entity, so the loader selects its `wireColumns` — the extension's named key
 * (`songId`, `conversationId`, …) included, with no `parentId` rename to write.
 *
 * This is a NUDGE, not a guarantee — modeled on `no-reactive-server-io`. It is
 * intentionally evadable by indirection, and that is accepted. The detection
 * deliberately favors FALSE NEGATIVES over FALSE POSITIVES: contributed rules run
 * as `error`, so a false positive BREAKS THE BUILD, whereas a false negative
 * merely misses an evasive case. Matching is NAME-BASED (identifier `db`, members
 * `select`/`from`/`map`) with NO type or import resolution — same philosophy as
 * `no-reactive-server-io`'s sink match.
 *
 * Fires only when ALL FOUR hold (see create() for the site-by-site checks):
 *   (1) The call is a `.map(cb)`.
 *   (2) Its receiver resolves (through local `const` bindings) to a call chain
 *       rooted at `db.select(...)` and containing a `.from(...)` member call.
 *   (3) `cb` is an arrow/function of a single param `p` returning an object
 *       literal in which EVERY property value is a *pure access of p* — `p.x`,
 *       `p.x.toISOString()`, or `p.x as T`. Anything else (a call other than
 *       `.toISOString()`, a `?? null`, a ternary, a non-`p` reference) means a
 *       genuine transform → we DO NOT report.
 *   (4) It sits inside a resource loader: the `loader` of a
 *       `defineResource({ loader })` or a `serveValue(value, { loader })`.
 */

const createRule = lintRuleCreator(import.meta.url);

/** The single call member that a pure projection may invoke on `p.x` (Date→wire). */
const ALLOWED_TRANSFORM_CALL = "toISOString";

/**
 * Walk up from a node to the nearest enclosing function scope and return its
 * block statements (where local `const`/`let`/`var` bindings live). Copied from
 * `no-reactive-server-io` — used to resolve a `.map` receiver identifier (e.g.
 * `rows`) back to its `const rows = await db.select()...` initializer.
 */
function enclosingStatements(node: TSESTree.Node): TSESTree.Statement[] | null {
  let cur: TSESTree.Node | undefined = node.parent;
  while (cur) {
    if (
      cur.type === "FunctionDeclaration" ||
      cur.type === "FunctionExpression" ||
      cur.type === "ArrowFunctionExpression"
    ) {
      if (cur.body.type === "BlockStatement") return cur.body.body;
      return null;
    }
    if (cur.type === "Program") return cur.body as TSESTree.Statement[];
    cur = cur.parent;
  }
  return null;
}

/**
 * Map `bindingName -> initializer expression` for simple `const/let/var <id> = <init>`
 * declarations. Only Identifier patterns are tracked (destructuring is skipped —
 * favoring false negatives). Copied from `no-reactive-server-io`.
 */
function collectBindingInitializers(
  statements: TSESTree.Statement[],
): Map<string, TSESTree.Expression> {
  const map = new Map<string, TSESTree.Expression>();
  for (const stmt of statements) {
    if (stmt.type !== "VariableDeclaration") continue;
    for (const decl of stmt.declarations) {
      if (decl.id.type === "Identifier" && decl.init) {
        map.set(decl.id.name, decl.init);
      }
    }
  }
  return map;
}

/**
 * (2) Does `expr` (the receiver of the `.map`) resolve to a `db.select().from(...)`
 * chain? Unwraps `await` / non-null / `as` wrappers, and follows a receiver
 * identifier through local bindings (the common `const rows = await db.select()...;
 * rows.map(...)` two-statement form). Bounded hop count so a self-referential or
 * unresolved binding can't loop — an unresolved binding returns false (favor a
 * false negative rather than guess).
 */
function receiverIsDbSelect(
  callObject: TSESTree.Node,
  bindings: Map<string, TSESTree.Expression>,
): boolean {
  let expr: TSESTree.Node | undefined = callObject;
  let hops = 0;
  while (expr && hops < 10) {
    hops++;
    if (expr.type === "AwaitExpression") {
      expr = expr.argument;
      continue;
    }
    if (expr.type === "TSNonNullExpression" || expr.type === "TSAsExpression") {
      expr = expr.expression;
      continue;
    }
    if (expr.type === "Identifier") {
      // Resolve `rows` -> its initializer. If we can't (param, import, shadowed,
      // destructured), bail to a false negative rather than assume it's a select.
      const init = bindings.get(expr.name);
      if (!init) return false;
      expr = init;
      continue;
    }
    break;
  }
  return chainIsDbSelect(expr);
}

/**
 * Name-based check that a call chain is `db.select(...)....from(...)...` — the
 * outermost node is a CallExpression/MemberExpression chain whose ROOT object is
 * the identifier `db` and whose member names include both `select` and `from`.
 * No type/import resolution (mirrors `no-reactive-server-io`); requiring the `db`
 * root + both members keeps this narrow (favor false negatives).
 */
function chainIsDbSelect(expr: TSESTree.Node | undefined): boolean {
  const members = new Set<string>();
  let root: string | null = null;
  let cur: TSESTree.Node | undefined = expr;
  let hops = 0;
  while (cur && hops < 50) {
    hops++;
    if (cur.type === "CallExpression") {
      cur = cur.callee;
      continue;
    }
    if (cur.type === "MemberExpression") {
      if (cur.property.type === "Identifier") members.add(cur.property.name);
      cur = cur.object;
      continue;
    }
    if (cur.type === "AwaitExpression") {
      cur = cur.argument;
      continue;
    }
    if (cur.type === "TSNonNullExpression") {
      cur = cur.expression;
      continue;
    }
    if (cur.type === "Identifier") {
      root = cur.name;
      break;
    }
    break;
  }
  return root === "db" && members.has("select") && members.has("from");
}

/**
 * Is `node` a *pure member access rooted at* `paramName`? — `p`, `p.x`, `p.x.y`.
 * Computed access is allowed only with a literal key (`p["x"]`); a computed
 * non-literal (`p[i]`) references another binding, so it's rejected. No calls.
 */
function isPureMemberRootedAt(node: TSESTree.Node, paramName: string): boolean {
  let cur: TSESTree.Node = node;
  while (cur.type === "MemberExpression") {
    // `p[i]` pulls in `i` — not a pure copy of the row. Only a literal key is pure.
    if (cur.computed && cur.property.type !== "Literal") return false;
    cur = cur.object;
  }
  return cur.type === "Identifier" && cur.name === paramName;
}

/**
 * (3, per-property) Is `node` a *pure access of `p`*? Exactly the three sanctioned
 * forms, and nothing else:
 *   - `p.x` / `p.x.y`             (pure member access rooted at p)
 *   - `p.x.toISOString()`        (the ONE allowed transform call — Date→ISO)
 *   - `p.x as T`                 (a cast over a pure access; recurse through it)
 * Everything else (any other call, `p.x ?? null`, a ternary, a binary op, a
 * non-`p` identifier, a template literal, etc.) is treated as a GENUINE TRANSFORM
 * and returns false — which stops the whole `.map` from being reported. This is
 * the crux of the false-negative bias: we report ONLY when we are confident the
 * projection is a lossless identity copy.
 */
function isPureAccessOfParam(node: TSESTree.Node, paramName: string): boolean {
  // `p.x as T` — unwrap the cast and re-check the inner access.
  if (node.type === "TSAsExpression") {
    return isPureAccessOfParam(node.expression, paramName);
  }
  // `p.x.toISOString()` — the only call form allowed, and only with no args.
  if (node.type === "CallExpression") {
    const callee = node.callee;
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      callee.property.name === ALLOWED_TRANSFORM_CALL &&
      node.arguments.length === 0
    ) {
      return isPureMemberRootedAt(callee.object, paramName);
    }
    return false;
  }
  // `p`, `p.x`, `p.x.y`
  if (node.type === "Identifier" || node.type === "MemberExpression") {
    return isPureMemberRootedAt(node, paramName);
  }
  return false;
}

/**
 * (3) Analyze the `.map` callback. Returns true only for an arrow/function of a
 * SINGLE identifier param whose returned object literal is an all-pure field copy
 * of that param. Any non-Property member (a spread `...r`), a computed key, a
 * missing/ambiguous return, or a single impure value → false (favor a false
 * negative). An empty object `{}` is not a projection worth flagging → false.
 */
function isPureIdentityProjection(cb: TSESTree.Node | undefined): boolean {
  if (
    !cb ||
    (cb.type !== "ArrowFunctionExpression" && cb.type !== "FunctionExpression")
  ) {
    return false;
  }
  // Exactly one identifier param — the row. Destructured/multiple params are a
  // transform-ish shape we don't attempt to reason about.
  const param = cb.params[0];
  if (cb.params.length !== 1 || param?.type !== "Identifier") return false;
  const paramName = param.name;

  // Locate the returned object literal: `(r) => ({...})` (expression body) or a
  // block with a single `return {...}`. A block with anything more complex than a
  // lone `return <ObjectExpression>` is left alone (favor a false negative).
  let obj: TSESTree.ObjectExpression | null = null;
  if (cb.body.type === "ObjectExpression") {
    obj = cb.body;
  } else if (cb.body.type === "BlockStatement") {
    for (const stmt of cb.body.body) {
      if (stmt.type === "ReturnStatement") {
        if (stmt.argument?.type === "ObjectExpression") obj = stmt.argument;
        // First return decides: a computed/non-object return means "not a plain
        // identity projection" → bail.
        break;
      }
    }
  }
  if (!obj || obj.properties.length === 0) return false;

  for (const prop of obj.properties) {
    // A spread (`...r`) or a computed key pulls in shape we won't vouch for.
    if (prop.type !== "Property" || prop.computed) return false;
    if (!isPureAccessOfParam(prop.value, paramName)) return false;
  }
  return true;
}

/** Simple key name of an object Property (`{ loader: ... }` → "loader"). */
function propertyKeyName(prop: TSESTree.Property): string | null {
  if (!prop.computed && prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal" && typeof prop.key.value === "string") {
    return prop.key.value;
  }
  return null;
}

/**
 * The calls whose options object carries a live-state resource `loader`: the
 * runtime's `defineResource` and network/live's `serveValue` (either arm — an
 * external value has no business projecting `db.select()` rows either).
 */
const LOADER_HOST_CALLEES = new Set(["defineResource", "serveValue"]);

/** Is `call` a loader host — bare `name(…)` or `X.name(…)`, for a name above? */
function isLoaderHostCall(call: TSESTree.CallExpression): boolean {
  const callee = call.callee;
  if (callee.type === "Identifier") return LOADER_HOST_CALLEES.has(callee.name);
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier"
  ) {
    return LOADER_HOST_CALLEES.has(callee.property.name);
  }
  return false;
}

/**
 * (4) Does `node` sit inside a resource loader? Walk parents to the nearest
 * object Property named `loader` whose object literal is an argument to a
 * `defineResource(...)` or `serveValue(...)` call. This scopes the rule to
 * live-state loaders (the flat `defineResource({...})`, the 2-arg
 * `defineResource(descriptor, {...})` and `serveValue(value, {...})` forms all
 * place `loader` as a direct Property of an argument object), so it never flags
 * endpoints, scripts, or ad-hoc `.map`s elsewhere. A loader passed by reference
 * (`loader: loadRows`) is not followed — the function it names is not inside
 * the call (favor a false negative).
 */
function isInsideResourceLoader(node: TSESTree.Node): boolean {
  let cur: TSESTree.Node | undefined = node.parent;
  while (cur) {
    if (cur.type === "Property" && propertyKeyName(cur) === "loader") {
      const objectLiteral = cur.parent;
      if (
        objectLiteral?.type === "ObjectExpression" &&
        objectLiteral.parent?.type === "CallExpression" &&
        isLoaderHostCall(objectLiteral.parent)
      ) {
        return true;
      }
    }
    cur = cur.parent;
  }
  return false;
}

export default createRule({
  name: "no-hand-rolled-entity-projection",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a hand-written identity row projection over db.select() inside " +
        "a resource loader — it silently drops any column you forget. Define the " +
        "table with defineEntity (or, for a 1:1 side-table, defineExtensionShape + " +
        "defineExtension) so the wire schema derives from the same field record, " +
        "and return db.select() rows verbatim.",
    },
    schema: [],
    messages: {
      handRolledProjection:
        "Hand-rolled row projection over db.select() in a resource loader " +
        "silently drops any column you forget. Define the table with defineEntity " +
        "(@plugins/infra/plugins/entities/server) so the wire schema derives from " +
        "the same field record, then return db.select() rows verbatim. For a 1:1 " +
        "side-table, declare it with defineExtensionShape " +
        "(@plugins/infra/plugins/entity-extensions/core) + defineExtension " +
        "(@plugins/infra/plugins/entity-extensions/server) and select the " +
        "handle's wireColumns — its named key replaces the parentId rename. See " +
        "research/2026-06-17-global-fields-unified-entities.md and " +
        "research/2026-09-11-global-define-extension-wire-schema.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        // (1) `.map(cb)` — cheapest filter first; discards nearly every call.
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "map"
        ) {
          return;
        }

        // (3) The callback must be an all-pure identity projection. Checked before
        // the (2) binding resolution because it's local and cheap, and it alone
        // excludes every genuine transform.
        if (!isPureIdentityProjection(node.arguments[0])) return;

        // (2) The receiver must resolve to a `db.select().from(...)` chain — either
        // inline `(await db.select()...).map` or the two-statement `const rows =
        // await db.select()...; rows.map`, resolved through local bindings.
        const statements = enclosingStatements(node);
        const bindings = statements
          ? collectBindingInitializers(statements)
          : new Map<string, TSESTree.Expression>();
        if (!receiverIsDbSelect(node.callee.object, bindings)) return;

        // (4) Must live inside a `defineResource({ loader })` or a
        // `serveValue(value, { loader })`.
        if (!isInsideResourceLoader(node)) return;

        context.report({ node, messageId: "handRolledProjection" });
      },
    };
  },
});
