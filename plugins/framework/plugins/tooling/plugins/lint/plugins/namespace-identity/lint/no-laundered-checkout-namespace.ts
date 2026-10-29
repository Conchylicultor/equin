import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The validating cast, spelled literally rather than imported.
 *
 * A rule file dual-loads under jiti (which cannot resolve `@plugins/*`) and Bun,
 * and an AST rule sees identifiers anyway — there is no binding to compare
 * against, only a name in the source. `asNamespace` itself is not the problem:
 * it is the documented boundary cast, and `asNamespace(row.worktree)` on a DB
 * column or `asNamespace(host)` on a URL are exactly what it is for. What it may
 * not be handed is a NAME someone derived from a filesystem path.
 */
const CAST = "asNamespace";

/**
 * The two producers of a checkout name, and why each is banned under the cast.
 *
 * `checkoutWorktreeName` returns a plain `string` on purpose, and says so in its
 * own docblock: a checkout name is one INPUT to a namespace, not a namespace.
 * `basename` is the same value with the helper's name filed off — it is how the
 * one live e2e instance was spelled.
 */
const CHECKOUT_NAME = "checkoutWorktreeName";
const PATH_SEGMENT = "basename";

/** The called name, whether spelled bare or through a namespace/module object. */
function calleeName(callee: TSESTree.Node): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

/**
 * Every call that could produce the value the cast receives.
 *
 * Not merely `argument.type === "CallExpression"`. The defect this rule exists
 * to close was written as `asNamespace(process.env.X ?? checkoutWorktreeName(root))`
 * — a fallback, where the laundering sits one operator down and a rule matching
 * only the direct nesting would have seen nothing at the one site that mattered.
 * So logical fallbacks, ternaries and type assertions are stepped through; each
 * of their branches is a value the cast can actually receive.
 */
function producerCalls(
  node: TSESTree.Node,
  out: TSESTree.CallExpression[],
): void {
  if (node.type === "CallExpression") {
    out.push(node);
    return;
  }
  if (node.type === "LogicalExpression") {
    producerCalls(node.left, out);
    producerCalls(node.right, out);
    return;
  }
  if (node.type === "ConditionalExpression") {
    producerCalls(node.consequent, out);
    producerCalls(node.alternate, out);
    return;
  }
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    producerCalls(node.expression, out);
  }
}

export default createRule({
  name: "no-laundered-checkout-namespace",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow casting a checkout directory name to a Namespace — a name is " +
        "one input to a namespace, not a namespace. Mint it, or read the deploy " +
        "this checkout actually published.",
    },
    schema: [],
    messages: {
      launderedCheckoutName:
        "`checkoutWorktreeName(root)` returns a plain string on purpose — a checkout " +
        "name is one INPUT to a namespace, not a namespace. Wrapping it in " +
        "`asNamespace` launders it past the `Namespace` brand and restates, as fact, " +
        "the guess the brand exists to stop: that a checkout's directory name IS the " +
        "namespace it serves. It is not. A `--composition sonata` build publishes " +
        "`sonata.<checkout>` and never the checkout's own name, so the cast names a " +
        "deploy that does not exist while a real one sits beside it — and every read " +
        "and write that follows lands on whatever else answers that name. Mint the " +
        "namespace instead — `namespaceFor(compositionId, ref)`, or " +
        "`checkoutNamespace(root)` — or, when what you want is the deploy this " +
        "checkout published, read it: `resolveCheckoutDeploy(root)` from " +
        "@plugins/infra/plugins/paths/core.",
      launderedPathSegment:
        "`basename(path)` is a path's last segment, not a namespace, and " +
        "`asNamespace` around it claims the directory that path points at is named " +
        "for the namespace it serves. For a checkout root that is the same wrong " +
        "guess `checkoutWorktreeName` makes — a `--composition sonata` build " +
        "publishes `sonata.<checkout>`, never the checkout's own name. For a " +
        "directory in the worktrees registry the name really is a namespace, but " +
        "the right read there is `isNamespace`, whose non-throwing answer lets one " +
        "stray directory be skipped instead of taking the whole scan down. Mint the " +
        "namespace with `namespaceFor` / `checkoutNamespace`, or read this checkout's " +
        "deploy with `resolveCheckoutDeploy(root)` from " +
        "@plugins/infra/plugins/paths/core.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (calleeName(node.callee) !== CAST) return;
        const [first] = node.arguments;
        if (first === undefined || first.type === "SpreadElement") return;

        const produced: TSESTree.CallExpression[] = [];
        producerCalls(first, produced);
        for (const call of produced) {
          const name = calleeName(call.callee);
          if (name === CHECKOUT_NAME) {
            context.report({ node: call, messageId: "launderedCheckoutName" });
          } else if (name === PATH_SEGMENT) {
            context.report({ node: call, messageId: "launderedPathSegment" });
          }
        }
      },
    };
  },
});
