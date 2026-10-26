import { AST_NODE_TYPES, ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

// A `refetchInterval` option (react-query's, or any wrapper forwarding its
// options into `useQuery`) re-asks the server on a timer whether anything
// changed. App data that changes has a change signal — a DB write, a file
// watcher, a git ref — and belongs in a live resource (a `liveValue` or a
// `liveCollection`) the server pushes.
// Keyed on the property name, so the option cannot be smuggled in through any
// wrapper that forwards it. A reader of something with genuinely no change
// signal (process internals on a debug panel) disables the rule on that line
// and says why.
export default createRule({
  name: "no-refetch-interval",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `refetchInterval` polling; push the value through a live resource.",
    },
    schema: [],
    messages: {
      polling:
        "`refetchInterval` polls the server on a timer. Declare this value as a " +
        "`liveValue` (or its rows as a `liveCollection`), serve it with " +
        "`serveValue` / `serveCollection` so it is pushed on change (a DB write, " +
        "a file watcher, a git ref advance), and read it with `useLive`. If the " +
        "source truly has no change signal, disable this rule on the line and say why.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      Property(node) {
        const key = node.key;
        const name =
          key.type === AST_NODE_TYPES.Identifier
            ? key.name
            : key.type === AST_NODE_TYPES.Literal
              ? key.value
              : null;
        if (name === "refetchInterval" && !node.computed) {
          context.report({ node, messageId: "polling" });
        }
      },
    };
  },
});
