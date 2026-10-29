/**
 * Bans a `catch` (try/catch clause or `.catch(handler)`) that resolves to an
 * absorbable empty/default value — `[]`, `{}`, `null`, `undefined` (incl.
 * `void 0`), `""`, `0`, `false`, or a local const initialized to one of those.
 *
 * Returning such a value from a catch republishes the failure AS ORDINARY DATA:
 * the caller can no longer tell a real result from a swallowed error, and
 * downstream layers cache/render the false-empty as settled truth. That is the
 * absorbable-failure bug class — a producer signalling failure with a value a
 * consumer can mistake for a legitimate result (empty list, zero count,
 * destructive default). See
 * `research/2026-07-08-global-absorbable-failure-guardrail.md` (Layer B).
 *
 * Sanctioned alternatives, in order of preference:
 *   - re-throw after handling the case you expect (the specific-handling
 *     pattern: narrow, act on the expected error, `throw err` the rest);
 *   - return a discriminated result the caller MUST branch on
 *     (`{ kind: "error", … }` / `{ ok: false, … }`);
 *   - if empty genuinely IS the correct answer here, a per-site
 *     `// eslint-disable-next-line promise-safety/no-absorbed-failure -- <why>`.
 *
 * Escape hatches (favor false negatives, like no-bare-catch):
 *   1. the catch/handler body contains a `throw` anywhere (specific-handling);
 *   2. the returned value is a discriminated object literal (a `kind` / `ok` /
 *      `status` / `error` property);
 *   3. a `.catch(handler)` chained directly on a RAW-BODY read — `.text()`,
 *      `.arrayBuffer()`, `.blob()`, `.bytes()`, `.formData()` (a Response body
 *      or a `Bun.file(...)` read). Tolerating a raw byte/text read failure with
 *      an empty value is the optional-read idiom (the empty is a diagnostic /
 *      degraded-content value, not a structured result a consumer mistakes for
 *      success). `.json()` is deliberately NOT exempt — it decodes into
 *      structured data a consumer branches on, so `res.json().catch(() => [])`
 *      is a real payload-absorption and still flags.
 *   4. per-site disable-with-reason (works automatically via ESLint).
 *
 * Deliberately NOT flagged: a bare `return;` in a void function (normal control
 * flow), and returns inside a nested function declared in the catch body (they
 * belong to that inner function, not the catch's control flow).
 *
 * The `unwrap` / `isEmptyDefaultLiteral` / `resolveVariable` / `initializerOf`
 * helpers are copied (~50 lines) from
 * `plugins/primitives/plugins/live-state/lint/no-pending-data-collapse.ts` —
 * jiti cannot resolve `@plugins/*` in rule files and cross-plugin relative
 * imports are banned, so duplication is the established pattern here.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { TSESLint } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

type MessageId = "absorbedCatch" | "absorbedCatchHandler";
type Ctx = Readonly<TSESLint.RuleContext<MessageId, []>>;

// --- Helpers copied from live-state/lint/no-pending-data-collapse.ts ---------

/** Strip `x as T` / `<T>x` / `x!` / parenthesized wrappers. */
function unwrap(node: TSESTree.Node): TSESTree.Node {
  let n = node;
  while (
    n.type === AST_NODE_TYPES.TSAsExpression ||
    n.type === AST_NODE_TYPES.TSTypeAssertion ||
    n.type === AST_NODE_TYPES.TSNonNullExpression
  ) {
    n = n.expression;
  }
  return n;
}

function resolveVariable(
  context: Ctx,
  ident: TSESTree.Identifier,
): TSESLint.Scope.Variable | null {
  let scope: TSESLint.Scope.Scope | null = context.sourceCode.getScope(ident);
  while (scope) {
    const v = scope.variables.find((v) => v.name === ident.name);
    if (v) return v;
    scope = scope.upper;
  }
  return null;
}

function initializerOf(
  context: Ctx,
  ident: TSESTree.Identifier,
): TSESTree.Expression | null {
  const def = resolveVariable(context, ident)?.defs[0];
  if (!def || def.node.type !== AST_NODE_TYPES.VariableDeclarator) return null;
  return def.node.init ?? null;
}

/**
 * An absorbable empty-default LITERAL: `[]`, `{}`, `null`, `false`, `0`, `""`,
 * the `undefined` identifier, or `void <expr>` (which evaluates to undefined).
 * (Extends the no-pending-data-collapse copy with the `void 0` case.)
 */
function isEmptyDefaultLiteral(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (n.type === AST_NODE_TYPES.ArrayExpression) return n.elements.length === 0;
  if (n.type === AST_NODE_TYPES.ObjectExpression)
    return n.properties.length === 0;
  if (n.type === AST_NODE_TYPES.Literal) {
    return (
      n.value === null || n.value === false || n.value === 0 || n.value === ""
    );
  }
  if (n.type === AST_NODE_TYPES.Identifier) return n.name === "undefined";
  if (n.type === AST_NODE_TYPES.UnaryExpression) return n.operator === "void";
  return false;
}

/** Empty-default literal, or a local const initialized to one (`const d = []`). */
function isEmptyDefault(context: Ctx, node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (isEmptyDefaultLiteral(n)) return true;
  if (n.type === AST_NODE_TYPES.Identifier) {
    const init = initializerOf(context, n);
    return init !== null && isEmptyDefaultLiteral(init);
  }
  return false;
}

// --- no-absorbed-failure-specific helpers -----------------------------------

const DISCRIMINANT_KEYS = new Set(["kind", "ok", "status", "error"]);

/** Non-computed string/identifier key name of an object property, or null. */
function propKeyName(p: TSESTree.ObjectLiteralElement): string | null {
  if (p.type !== AST_NODE_TYPES.Property || p.computed) return null;
  if (p.key.type === AST_NODE_TYPES.Identifier) return p.key.name;
  if (
    p.key.type === AST_NODE_TYPES.Literal &&
    typeof p.key.value === "string"
  ) {
    return p.key.value;
  }
  return null;
}

/**
 * Is `node` a sanctioned discriminated-result object literal — one carrying a
 * `kind` / `ok` / `status` / `error` discriminant the caller must branch on
 * (`{ kind: "error", … }`, `{ ok: false, … }`)? Such a value is a TYPE the
 * consumer handles, not an absorbable empty, so it is exempt.
 */
function isDiscriminatedResult(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (n.type !== AST_NODE_TYPES.ObjectExpression) return false;
  return n.properties.some((p) => {
    const key = propKeyName(p);
    return key !== null && DISCRIMINANT_KEYS.has(key);
  });
}

function isAstNode(value: unknown): value is TSESTree.Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function isFunctionNode(node: TSESTree.Node): boolean {
  return (
    node.type === AST_NODE_TYPES.FunctionDeclaration ||
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression
  );
}

/** Walk `node`'s subtree, invoking `visit`; never descends into `parent`. */
function walk(
  node: TSESTree.Node,
  visit: (n: TSESTree.Node) => "skip-children" | void,
): void {
  if (visit(node) === "skip-children") return;
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const c of child) if (isAstNode(c)) walk(c, visit);
    } else if (isAstNode(child)) {
      walk(child, visit);
    }
  }
}

/**
 * Does the catch/handler body re-throw ANYWHERE (including inside nested
 * closures)? A single `throw` marks the specific-handling pattern — narrow,
 * return a default for the expected case, rethrow the rest — so the whole
 * catch is exempt. Detecting throws leniently (any depth) means a legitimate
 * rethrow is never a false positive.
 */
function containsThrow(body: TSESTree.Node): boolean {
  let found = false;
  walk(body, (n) => {
    if (n.type === AST_NODE_TYPES.ThrowStatement) found = true;
  });
  return found;
}

/**
 * Returns the catch/handler body's OWN `return` statements — NOT descending
 * into nested function declarations/expressions/arrows, whose returns belong to
 * that inner function rather than the catch's control flow.
 */
function collectOwnReturns(body: TSESTree.Node): TSESTree.ReturnStatement[] {
  const returns: TSESTree.ReturnStatement[] = [];
  walk(body, (n) => {
    if (n !== body && isFunctionNode(n)) return "skip-children";
    if (n.type === AST_NODE_TYPES.ReturnStatement) returns.push(n);
  });
  return returns;
}

/** Raw byte/text body readers whose failure-to-empty is the optional-read idiom. */
const RAW_BODY_READERS = new Set([
  "text",
  "arrayBuffer",
  "blob",
  "bytes",
  "formData",
]);

/**
 * Is `receiver` a raw-body read call — `x.text()` / `x.arrayBuffer()` / … — the
 * receiver a `.catch(handler)` is chained on? `.json()` is intentionally absent:
 * it decodes structured data a consumer branches on, so its absorption is a real
 * failure, not an optional read.
 */
function isRawBodyRead(receiver: TSESTree.Node): boolean {
  const n = unwrap(receiver);
  return (
    n.type === AST_NODE_TYPES.CallExpression &&
    n.callee.type === AST_NODE_TYPES.MemberExpression &&
    !n.callee.computed &&
    n.callee.property.type === AST_NODE_TYPES.Identifier &&
    RAW_BODY_READERS.has(n.callee.property.name)
  );
}

/** Is `arg` an empty-default the caller absorbs (and not a discriminated result)? */
function isAbsorbedValue(context: Ctx, arg: TSESTree.Node): boolean {
  if (isDiscriminatedResult(arg)) return false;
  return isEmptyDefault(context, arg);
}

/**
 * Does a block-bodied catch/handler resolve to an absorbed empty-default? True
 * when it has no reachable `throw` (escape hatch 1) and at least one own
 * `return <empty-default>` (a bare `return;` never counts).
 */
function blockResolvesEmpty(context: Ctx, body: TSESTree.Node): boolean {
  if (containsThrow(body)) return false;
  return collectOwnReturns(body).some(
    (ret) => ret.argument !== null && isAbsorbedValue(context, ret.argument),
  );
}

export default createRule<[], MessageId>({
  name: "no-absorbed-failure",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a catch that returns/resolves an absorbable empty-default — it republishes failure as ordinary data.",
    },
    schema: [],
    messages: {
      absorbedCatch:
        'Returning an empty/default value (`[]`, `{}`, `null`, `0`, `""`, `false`, `undefined`) from a catch ' +
        "republishes the failure AS DATA — the caller can no longer tell a real result from a swallowed error, and " +
        "downstream code caches/renders the false-empty as settled truth (the absorbable-failure bug class). " +
        "Fail loudly instead: re-throw after handling the case you expect " +
        "(`catch (err) { if (isExpected(err)) …; throw err; }`), or return a discriminated result the caller MUST " +
        'branch on (`{ kind: "error", … }` / `{ ok: false, … }`). If empty genuinely IS the right answer here, say ' +
        "why with `// eslint-disable-next-line promise-safety/no-absorbed-failure -- <why empty is a real answer, " +
        "not a failure signal>`. See research/2026-07-08-global-absorbable-failure-guardrail.md.",
      absorbedCatchHandler:
        '.catch(handler) resolving to an empty/default value (`[]`, `{}`, `null`, `0`, `""`, `false`, `undefined`) ' +
        "republishes the failure AS DATA — the caller sees a legitimate-looking result and the error becomes invisible " +
        "(the absorbable-failure bug class). Fail loudly instead: re-throw after handling the case you expect, or " +
        'resolve to a discriminated result the caller MUST branch on (`{ kind: "error", … }` / `{ ok: false, … }`). ' +
        "If empty genuinely IS the right answer here, say why with " +
        "`// eslint-disable-next-line promise-safety/no-absorbed-failure -- <why empty is a real answer, not a " +
        "failure signal>`. See research/2026-07-08-global-absorbable-failure-guardrail.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // try/catch — a catch clause whose own control flow returns an empty-default.
      CatchClause(node: TSESTree.CatchClause) {
        if (blockResolvesEmpty(context, node.body)) {
          context.report({ node, messageId: "absorbedCatch" });
        }
      },

      // .catch(handler) — an inline arrow/function handler resolving an empty-default.
      "CallExpression[callee.property.name='catch']"(
        node: TSESTree.CallExpression,
      ) {
        const arg = node.arguments[0];
        if (!arg) return;

        // Raw-body read tolerance: `res.text().catch(() => "")` etc. (escape #3).
        if (
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          isRawBodyRead(node.callee.object)
        ) {
          return;
        }

        // Expression-bodied arrow: `.catch(() => null)`, `.catch(() => ({}))`.
        // (`.catch(() => {})` is an empty BLOCK — no-bare-catch's territory.)
        if (
          arg.type === AST_NODE_TYPES.ArrowFunctionExpression &&
          arg.body.type !== AST_NODE_TYPES.BlockStatement
        ) {
          if (isAbsorbedValue(context, arg.body)) {
            context.report({ node, messageId: "absorbedCatchHandler" });
          }
          return;
        }

        // Block-bodied arrow/function: `.catch(() => { return []; })`.
        if (
          (arg.type === AST_NODE_TYPES.ArrowFunctionExpression ||
            arg.type === AST_NODE_TYPES.FunctionExpression) &&
          arg.body.type === AST_NODE_TYPES.BlockStatement &&
          blockResolvesEmpty(context, arg.body)
        ) {
          context.report({ node, messageId: "absorbedCatchHandler" });
        }
      },
    };
  },
});
