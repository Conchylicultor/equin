import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-pure-write-transaction
 *
 * A `db.transaction(cb)` whose body is nothing but writes — two or more
 * awaited `tx.insert / update / delete` (or `tx.execute(sql\`INSERT|UPDATE|
 * DELETE …\`)`) whose results are discarded — holds its connection, and every
 * row lock its first write took, across one app round trip per later write.
 * Between two of them the server sits `idle in transaction`: if the app stalls
 * or loses the connection there, every writer of those rows queues behind a
 * session that is waiting on nobody. That is the shape of the 2026-11-03
 * incident (research/2026-11-04-global-db-connection-failure-vision.md, point 5).
 *
 * Writes that need no read in between need no transaction: `writeAtomically`
 * (`@plugins/database/server`) composes them into ONE statement (a
 * data-modifying CTE), atomic and one round trip, so the window does not exist.
 *
 * The rule judges only what it can see. It stays silent on a transaction that
 * awaits anything else — a read, a result that is used, a lock
 * (`FOR UPDATE`, `pg_advisory_xact_lock`, `LOCK`), a helper handed `tx` —
 * because those are the cases a transaction exists for (a read feeding a write,
 * an explicit lock). A write in a loop counts as several, since it runs once
 * per item.
 */

const createRule = lintRuleCreator(import.meta.url);

type FunctionLike =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionExpression
  | TSESTree.FunctionDeclaration;

const WRITE_METHODS = new Set(["insert", "update", "delete"]);
const WRITE_SQL = /^\s*(insert|update|delete)\b/i;
const LOCK_SQL = /\bfor\s+(no\s+key\s+)?(update|share)\b|pg_advisory|\block\s/i;

function isFunction(node: TSESTree.Node): node is FunctionLike {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

function isLoop(node: TSESTree.Node): boolean {
  return (
    node.type === "ForStatement" ||
    node.type === "ForOfStatement" ||
    node.type === "ForInStatement" ||
    node.type === "WhileStatement" ||
    node.type === "DoWhileStatement"
  );
}

/** `tx.transaction(cb)` / `db.transaction(cb)` with a plain-identifier binding. */
function transactionCallback(
  node: TSESTree.CallExpression,
): { callback: FunctionLike; tx: string } | undefined {
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.property.type !== "Identifier" ||
    callee.property.name !== "transaction"
  ) {
    return undefined;
  }
  const arg = node.arguments[0];
  if (
    arg?.type !== "ArrowFunctionExpression" &&
    arg?.type !== "FunctionExpression"
  ) {
    return undefined;
  }
  const param = arg.params[0];
  if (param?.type !== "Identifier") return undefined;
  return { callback: arg, tx: param.name };
}

/** The call made directly on `tx` in a chain: `tx.insert(t)` in `tx.insert(t).values(v)`. */
function rootCall(
  node: TSESTree.Expression,
  tx: string,
): TSESTree.CallExpression | undefined {
  let cur: TSESTree.Node = node;
  let innermost: TSESTree.CallExpression | undefined;
  for (;;) {
    if (cur.type === "CallExpression") {
      innermost = cur;
      cur = cur.callee;
    } else if (cur.type === "MemberExpression") {
      if (cur.object.type === "Identifier" && cur.object.name === tx) {
        return innermost !== undefined && innermost.callee === cur
          ? innermost
          : undefined;
      }
      cur = cur.object;
    } else if (cur.type === "TSNonNullExpression") {
      cur = cur.expression;
    } else {
      return undefined;
    }
  }
}

/** The text of a `sql\`…\`` template, interpolations elided. */
function sqlTemplateText(node: TSESTree.Node | undefined): string | undefined {
  if (node?.type !== "TaggedTemplateExpression") return undefined;
  if (node.tag.type !== "Identifier" || node.tag.name !== "sql")
    return undefined;
  return node.quasi.quasis
    .map((q) => q.value.cooked ?? q.value.raw)
    .join(" ? ");
}

/**
 * Is this awaited call a write on `tx` whose result nothing reads? Anything
 * else makes the transaction one the rule cannot judge.
 */
function isDiscardedWrite(
  await_: TSESTree.AwaitExpression,
  tx: string,
): boolean {
  if (await_.parent.type !== "ExpressionStatement") return false;
  const arg = await_.argument;
  if (arg.type !== "CallExpression") return false;
  const root = rootCall(arg, tx);
  if (root === undefined) return false;
  const callee = root.callee as TSESTree.MemberExpression;
  if (callee.property.type !== "Identifier") return false;
  const method = callee.property.name;
  if (WRITE_METHODS.has(method)) return true;
  if (method === "execute") {
    const text = sqlTemplateText(root.arguments[0]);
    return text !== undefined && WRITE_SQL.test(text) && !LOCK_SQL.test(text);
  }
  return false;
}

function isNode(value: unknown): value is TSESTree.Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** Does this switch case end without falling through? */
function endsCase(c: TSESTree.SwitchCase): boolean {
  const last = c.consequent.at(-1);
  return (
    last?.type === "BreakStatement" ||
    last?.type === "ReturnStatement" ||
    last?.type === "ThrowStatement" ||
    last?.type === "ContinueStatement"
  );
}

/** The child nodes of `node`, in source order. */
function children(node: TSESTree.Node): TSESTree.Node[] {
  const out: TSESTree.Node[] = [];
  for (const key of Object.keys(node) as (keyof TSESTree.Node)[]) {
    if (key === "parent") continue;
    const value = node[key] as unknown;
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) out.push(child);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

/**
 * The most writes one run of `node` can await — `undefined` when it awaits
 * something the rule cannot judge (anything but a discarded write on `tx`, or a
 * nested async function, whose round trips run on their own schedule).
 * Branches take their larger arm, not their sum: `if (a) await w1; else await
 * w2;` is one round trip whichever runs. A loop's body counts twice, since it
 * runs once per item.
 */
function maxWrites(node: TSESTree.Node, tx: string): number | undefined {
  if (isFunction(node)) {
    // A sync callback (`rows.map((r) => …)`) awaits nothing.
    return node.async ? undefined : 0;
  }
  if (node.type === "AwaitExpression") {
    return isDiscardedWrite(node, tx) ? 1 : undefined;
  }
  if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
    // The test runs, then one arm.
    const test = maxWrites(node.test, tx);
    const consequent = maxWrites(node.consequent, tx);
    const alternate = node.alternate ? maxWrites(node.alternate, tx) : 0;
    if (
      test === undefined ||
      consequent === undefined ||
      alternate === undefined
    )
      return undefined;
    return test + Math.max(consequent, alternate);
  }
  if (node.type === "SwitchStatement") {
    // A case that does not end in break / return / throw / continue falls
    // through to the next, so the worst entry is the most writes from any case
    // to the first one that ends.
    const discriminant = maxWrites(node.discriminant, tx);
    if (discriminant === undefined) return undefined;
    let tail = 0;
    let worst = 0;
    for (const c of [...node.cases].reverse()) {
      const n = maxWrites(c, tx);
      if (n === undefined) return undefined;
      tail = endsCase(c) ? n : n + tail;
      worst = Math.max(worst, tail);
    }
    return discriminant + worst;
  }
  const counts: number[] = [];
  for (const child of children(node)) {
    const n = maxWrites(child, tx);
    if (n === undefined) return undefined;
    counts.push(n);
  }
  const sum = counts.reduce((a, b) => a + b, 0);
  return isLoop(node) ? sum * 2 : sum;
}

export default createRule({
  name: "no-pure-write-transaction",
  meta: {
    type: "problem",
    docs: {
      description:
        "a transaction of several pure writes is one statement (writeAtomically), " +
        "never round trips that leave the server idle in transaction holding locks",
    },
    schema: [],
    messages: {
      pureWrites:
        "This transaction is only writes on `{{tx}}`, one round trip each: between two of " +
        "them the server sits idle in transaction holding the first write's row locks, and a " +
        "stalled or lost app connection there queues every other writer of those rows (the " +
        "2026-11-03 incident). Writes that read nothing in between need no transaction: issue " +
        "them as ONE statement with `writeAtomically(exec, [w1, w2, …])` from " +
        "`@plugins/database/server` — its arms all see the snapshot from before the statement, " +
        "so a write that must see another's effect (an UPDATE of a row an earlier write " +
        "inserts, a DELETE then re-INSERT of one key) is folded into one arm first (an upsert); " +
        "same-shaped rows are one multi-row statement. See " +
        "research/2026-11-04-global-db-connection-failure-vision.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const bound = transactionCallback(node);
        if (!bound) return;
        const { callback, tx } = bound;

        const writes = maxWrites(callback.body, tx);
        if (writes !== undefined && writes >= 2) {
          context.report({ node, messageId: "pureWrites", data: { tx } });
        }
      },
    };
  },
});
