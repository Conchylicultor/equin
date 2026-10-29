import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-pool-await-in-transaction
 *
 * `db.transaction(cb)` checks out ONE pooled Postgres connection and holds it
 * for the whole life of `cb`. Every `await` inside the callback therefore
 * extends the connection lease by however long that await takes — and under
 * event-loop lag (~1s p50 at host load ~50, measured) a 3-await transaction
 * holds its connection for ~3s instead of ~10ms. That 100–500× lease inflation
 * is what saturated the 16-connection pool during the 2026-07-09 incident.
 *
 * Worse than slow: an `await` on the POOL from inside a transaction is a
 * hold-and-wait shape — the transaction pins one connection while queueing for
 * a second one. With enough concurrent transactions that is a deadlock, not a
 * slowdown.
 *
 * The scope is not only `db.transaction(cb)`. A domain may wrap a transaction
 * behind its own chokepoint — `withPageForest(scopes, cb)`, the page editor's
 * forest-write lock — and the hazard is identical, so the openers are a table
 * (`TX_SCOPE_OPENERS`) rather than one hardcoded shape. A chokepoint whose
 * callback binds a CONTEXT object needs no extra machinery: naming `ctx` as the
 * executor binding makes `ctx.tx.select(…)` and `helper(ctx.tx)` pass under the
 * two conditions below exactly as `tx` does.
 *
 * So: inside a transaction-scope callback, every awaited call expression must run
 * on the transaction executor. It passes if the call is
 *   (1) a member chain rooted at the executor binding — `tx.insert(…)`,
 *       `tx.select().from(…)`, `tx.execute(sql\`…\`)`, `ctx.tx.insert(…)`,
 *       `ctx.forest()`; or
 *   (2) handed the executor binding as an argument — `insertForest(tx, {…})`,
 *       `nextRankIn(_conversationGroups, tx)`, `store.run(batch, () => fn(tx))`,
 *       `emit(payload, { tx: batch.tx })`, `writeForestTarget(ctx, a, b)`.
 *
 * A struct literal declared in the callback that carries the executor
 * (`const batch = { tx, before: new Map() }`) counts as the executor for (2),
 * so `flushStatusBatch(batch)` passes — the transaction is reachable from it.
 *
 * Anything else — `await db.select()…`, `await fetch(url)`,
 * `await listBlockingDepIds(taskId)`, an fs read, a gate acquire — is reported.
 *
 * KNOWN LIMIT — the rule cannot see one hop down. A call that merely *receives*
 * the executor (directly or via a carrier struct) satisfies condition (2) even
 * if the helper ignores it and reads off the pool internally. The real instance:
 * `await cascadeBlockedDependents(conversationId, tx)` passes here, yet the
 * helper called `listBlockingDepIds(taskId)` with no executor and hit the pool.
 * That transitive class is closed by a different mechanism — making the executor
 * a REQUIRED parameter on those query helpers, so the leak is a tsc error rather
 * than a runtime hazard (Task 5b). This rule and the required-param convention
 * are two halves of one guardrail; neither is sufficient alone.
 *
 * See research/2026-07-09-global-interactive-lane-origin-based-db-gating.md
 * (Task 5) and its forensic companion
 * research/2026-07-09-global-interactive-lane-under-load.md.
 */

const createRule = lintRuleCreator(import.meta.url);

type FunctionLike =
  TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

/**
 * A call whose CALLBACK body runs while one pooled connection is checked out.
 *
 * `db.transaction(cb)` is drizzle's own. It is not the only one: a domain can
 * wrap a transaction behind a chokepoint — `withPageForest(scopes, cb)`, the
 * page editor's forest-write lock — and the callback then binds a CONTEXT object
 * carrying the executor (`ctx.tx`) rather than the executor itself. That is
 * exactly the "struct literal that carries the executor" shape condition (2)
 * already models, so the carrier machinery below needs no change at all: naming
 * `ctx` as the binding makes `ctx.tx.select(…)` root-matched and
 * `helper(ctx.tx)` argument-matched for free. Only the callback's ARGUMENT
 * POSITION differs.
 *
 * **Why a named registry rather than a structural rule.** A convention like
 * "any `with*(…, cb)` call opens a transaction scope" would over-match every
 * scope helper in the repo — `withHeavyReadSlot`, `withBrowser`,
 * `runInBackgroundLane` — none of which hold a connection, turning every
 * legitimate pool call inside them into a build failure. A type-aware match
 * ("is this parameter a `PageForestCtx`") is unavailable: a contributed rule
 * file is loaded by jiti, which cannot resolve the `@plugins/*` alias, so the
 * rule cannot name the type. A table of openers is the honest middle — one
 * place, one line per chokepoint, and it generalizes the `.transaction`
 * hardcode this rule already carried rather than adding a second special case.
 */
interface TxScopeOpener {
  /** `member` = `<x>.transaction(cb)`; `free` = `withPageForest(…, cb)`. */
  kind: "member" | "free";
  name: string;
  /** Which argument is the callback. */
  callbackArg: number;
  /** Where work that must NOT hold the connection belongs, for the message. */
  remedy: string;
}

const TX_SCOPE_OPENERS: readonly TxScopeOpener[] = [
  {
    kind: "member",
    name: "transaction",
    callbackArg: 0,
    remedy: "hoist it above the `transaction()` call",
  },
  {
    kind: "free",
    name: "withPageForest",
    callbackArg: 1,
    remedy:
      "queue it on `ctx.afterCommit(…)`, which runs it the moment the write " +
      "commits and the page lock is released",
  },
  // The tasks status batch. `withTaskStatusBatch(fn)` opens the transaction
  // itself and hands `fn` the executor; `runStatusBatchOn(tx, fn)` joins a
  // transaction the caller already opened. Both run their callback with one
  // pooled connection checked out for its whole life, so both are openers —
  // and neither was registered, which left every pool await inside a status
  // batch unflagged.
  {
    kind: "free",
    name: "withTaskStatusBatch",
    callbackArg: 0,
    remedy: "hoist it above the `withTaskStatusBatch()` call",
  },
  {
    kind: "free",
    name: "runStatusBatchOn",
    callbackArg: 1,
    remedy: "hoist it above the `runStatusBatchOn()` call",
  },
];

/** The opener this call is, if any — the shape that checks out a connection. */
function txScopeOpener(node: TSESTree.Node): TxScopeOpener | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = node.callee;
  if (callee.type === "Identifier") {
    return TX_SCOPE_OPENERS.find(
      (o) => o.kind === "free" && o.name === callee.name,
    );
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    const property = callee.property;
    return TX_SCOPE_OPENERS.find(
      (o) => o.kind === "member" && o.name === property.name,
    );
  }
  return undefined;
}

/**
 * The executor binding a transaction callback introduces — `tx` in
 * `db.transaction(async (tx) => …)`, `ctx` in
 * `withPageForest(scopes, async (ctx) => …)`. `undefined` when the callback
 * declares no plain-identifier first param — there is then no executor to
 * thread, so the callback is unverifiable and we skip it rather than report
 * every await. (A DESTRUCTURED param, `async ({ tx }) => …`, is that case: it
 * binds the executor under a name the carrier walk can still see, but the
 * binding is no longer one identifier, so the rule stays silent rather than
 * guessing. Bind the whole context and reach through it.)
 */
function executorBinding(
  call: TSESTree.CallExpression,
  opener: TxScopeOpener,
): { callback: FunctionLike; name: string } | undefined {
  const arg = call.arguments[opener.callbackArg];
  if (
    arg?.type !== "ArrowFunctionExpression" &&
    arg?.type !== "FunctionExpression"
  ) {
    return undefined;
  }
  const param = arg.params[0];
  if (param?.type !== "Identifier") return undefined;
  return { callback: arg, name: param.name };
}

/** Innermost object of a member/call chain: `tx.select().from(x)` → `tx`. */
function chainRoot(node: TSESTree.Node): TSESTree.Node {
  let cur = node;
  for (;;) {
    if (cur.type === "MemberExpression") cur = cur.object;
    else if (cur.type === "CallExpression") cur = cur.callee;
    else if (cur.type === "TSNonNullExpression") cur = cur.expression;
    else return cur;
  }
}

/**
 * Does `name` appear anywhere in this argument subtree? Deliberately coarse —
 * it matches an identifier reference (`insertForest(tx, …)`), a closure capture
 * (`() => fn(tx)`), a shorthand or explicit property (`{ tx }`, `{ tx: … }`),
 * and a member property (`batch.tx`). All of them hand the executor down; the
 * rule's job is to catch calls that hand it down NOWHERE.
 */
function mentionsName(node: TSESTree.Node, name: string): boolean {
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (n.type === "Identifier" && n.name === name) found = true;
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

/**
 * Names from which the executor is reachable: the binding itself, plus any
 * struct literal declared in the callback that closes over it — the real shape
 * being `const batch = { tx, before: new Map() }`, later handed to
 * `flushStatusBatch(batch)`. Restricted to object/array literals on purpose: a
 * `const rows = await tx.select()` result carries DATA, not the executor, and
 * must not launder a subsequent pool call.
 */
function executorCarriers(body: TSESTree.Node, name: string): Set<string> {
  const carriers = new Set([name]);
  for (let grew = true; grew;) {
    grew = false;
    walk(body, (n) => {
      if (n.type !== "VariableDeclarator" || n.id.type !== "Identifier")
        return true;
      const init = n.init;
      if (init === null || carriers.has(n.id.name)) return true;
      if (init.type !== "ObjectExpression" && init.type !== "ArrayExpression")
        return true;
      if ([...carriers].some((c) => mentionsName(init, c))) {
        carriers.add(n.id.name);
        grew = true;
      }
      return true;
    });
  }
  return carriers;
}

export default createRule({
  name: "no-pool-await-in-transaction",
  meta: {
    type: "problem",
    docs: {
      description:
        "no await on the pool inside a db.transaction callback " +
        "(hold-and-wait + inflated connection lease)",
    },
    schema: [],
    messages: {
      poolAwait:
        "This awaited call does not receive the transaction executor `{{tx}}`, so it runs " +
        "on the pool while the enclosing `{{opener}}` already holds a pooled connection — " +
        "hold-and-wait, and the connection lease inflates by this call's whole duration " +
        "(seconds under event-loop lag, not milliseconds). Run it on the transaction: call " +
        "`{{tx}}.…` directly (`{{tx}}.tx.…` when the binding is a context object), or pass " +
        "`{{tx}}` to the helper (make its executor parameter REQUIRED, not `= db`). If the " +
        "work genuinely must not join the transaction, {{remedy}}. See " +
        "research/2026-07-09-global-interactive-lane-origin-based-db-gating.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const opener = txScopeOpener(node);
        if (!opener) return;
        const bound = executorBinding(node, opener);
        if (!bound) return;
        const { callback, name } = bound;
        const carriers = executorCarriers(callback.body, name);

        walk(callback.body, (n) => {
          // A nested scope opener rebinds the executor and is visited as its
          // own CallExpression — its body is not ours to judge. (The `await`
          // wrapping it is still ours, and is reported unless it threads our
          // executor: a second checked-out connection is the hold-and-wait
          // shape whichever chokepoint opens it.)
          if (n !== callback.body && txScopeOpener(n)) return false;

          if (n.type !== "AwaitExpression") return true;
          const call = n.argument;
          if (call.type !== "CallExpression") return true;

          const root = chainRoot(call.callee);
          const rootedAtTx =
            root.type === "Identifier" && carriers.has(root.name);
          const threadsTx = call.arguments.some((a) =>
            [...carriers].some((c) => mentionsName(a, c)),
          );
          if (!rootedAtTx && !threadsTx) {
            context.report({
              node: call,
              messageId: "poolAwait",
              data: {
                tx: name,
                opener:
                  opener.kind === "member"
                    ? "transaction()"
                    : `${opener.name}()`,
                remedy: opener.remedy,
              },
            });
          }
          return true;
        });
      },
    };
  },
});
