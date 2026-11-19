import type { TSESTree } from "@typescript-eslint/utils";
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/** Through `x as T`, `x!`, `x satisfies T` and parentheses. */
function unwrap(node: TSESTree.Node): TSESTree.Node {
  let n = node;
  while (
    n.type === "TSAsExpression" ||
    n.type === "TSNonNullExpression" ||
    n.type === "TSSatisfiesExpression" ||
    n.type === "TSTypeAssertion"
  )
    n = n.expression;
  return n;
}

const ROUNDING = new Set(["round", "floor", "ceil", "trunc"]);

/**
 * `performance.timeOrigin`, `x.timeOrigin`, or a binding named `timeOrigin` —
 * through `Math.round(…)` and its kin.
 */
function isTimeOrigin(node: TSESTree.Node): boolean {
  const n = unwrap(node);
  if (n.type === "Identifier") return n.name === "timeOrigin";
  if (
    n.type === "CallExpression" &&
    n.arguments.length === 1 &&
    n.callee.type === "MemberExpression" &&
    n.callee.object.type === "Identifier" &&
    n.callee.object.name === "Math" &&
    n.callee.property.type === "Identifier" &&
    ROUNDING.has(n.callee.property.name)
  ) {
    const [arg] = n.arguments;
    return arg !== undefined && isTimeOrigin(arg);
  }
  return (
    n.type === "MemberExpression" &&
    !n.computed &&
    n.property.type === "Identifier" &&
    n.property.name === "timeOrigin"
  );
}

/**
 * `performance.timeOrigin + stamp` reads as "the stamp on the wall clock", and
 * is not: the performance timeline pauses while the device sleeps (Chrome on
 * Android, macOS), so after a sleep the sum lags `Date.now()` by every sleep
 * since the page loaded — a stall's profiler samples landed hours before the
 * stall they sampled (report-1795091821-xwqzky). So the sum (or difference)
 * has no spelling: convert through primitives/perfs/page-clock, whose offset
 * is read when the stamps are taken. Reading `timeOrigin` alone — when this
 * realm started, on the wall clock — stays allowed.
 */
export default createRule({
  name: "no-time-origin-arithmetic",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow adding or subtracting performance.timeOrigin to move a stamp between the performance timeline and the wall clock — use perfToEpoch / epochToPerf.",
    },
    schema: [],
    messages: {
      arithmetic:
        "`timeOrigin ± stamp` is not the wall clock: the performance timeline pauses while the " +
        "device sleeps (Chrome on Android, macOS), so after a sleep it lags `Date.now()` by every " +
        "sleep since the page loaded (a stall's profiler samples landed hours before the stall, " +
        "report-1795091821-xwqzky). Convert with `perfToEpoch(asPerfMs(stamp))` / `epochToPerf(t)` " +
        "from @plugins/primitives/plugins/perfs/plugins/page-clock/core — they read the clocks' " +
        "offset now, or take the `clockOffset()` read when the stamps were collected.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator !== "+" && node.operator !== "-") return;
        if (isTimeOrigin(node.left) || isTimeOrigin(node.right))
          context.report({ node, messageId: "arithmetic" });
      },
      AssignmentExpression(node) {
        if (node.operator !== "+=" && node.operator !== "-=") return;
        if (isTimeOrigin(node.right))
          context.report({ node, messageId: "arithmetic" });
      },
    };
  },
});
