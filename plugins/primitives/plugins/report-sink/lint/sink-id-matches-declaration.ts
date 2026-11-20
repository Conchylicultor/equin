import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import { asFsPath } from "@plugins/framework/plugins/plugin-id/core";
import { pluginOfFile } from "./sink-owner";

const createRule = lintRuleCreator(import.meta.url);

/** The factories whose first argument is the sink's id. */
const SINK_FACTORIES = new Set(["defineReportSink", "defineRequestSink"]);

/**
 * The id a sink declared in `file` as `const <binding>` must carry:
 * `<plugin path>:<binding>` (`database/plugins/connection:queryDeadlineSink`),
 * or `null` for a file outside `plugins/`.
 */
function expectedId(file: string, binding: string): string | null {
  const plugin = pluginOfFile(file);
  return plugin === null ? null : `${asFsPath(plugin)}:${binding}`;
}

/**
 * sink-id-matches-declaration
 *
 * A report / request sink's id (`defineReportSink(id)`, `defineRequestSink(id)`)
 * names its handler in the build's table (`contributors.generated.ts`, as
 * `sink:<id>`): a process that starts only some plugins starts the handler of
 * every sink its modules declare. A copied id would merge two sinks there, so
 * the id is not a free string: it is the literal `<plugin path>:<binding>` of
 * the `const` it initializes (autofixed). That two declarations never share
 * one (the same binding in two files of a plugin) is a whole-repo fact a
 * per-file lint cannot see: the `report-sink:unique-sink-ids` check's.
 */
export default createRule({
  name: "sink-id-matches-declaration",
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "A report/request sink's id is the literal `<plugin path>:<binding>` of the const it initializes — it names the sink's handler in the build's contributors table.",
    },
    schema: [],
    messages: {
      notBound:
        'Bind this sink to a `const` (`export const fooSink = {{factory}}("<plugin path>:fooSink")`): its id is derived from that binding.',
      notLiteral:
        "The sink's id must be the string literal {{expected}}: it names the sink's handler in the build's contributors table.",
      mismatch:
        "Sink id {{actual}} does not match its declaration: it must be {{expected}} (`<plugin path>:<binding>`), the key naming its handler in the build's contributors table.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (
          node.callee.type !== "Identifier" ||
          !SINK_FACTORIES.has(node.callee.name)
        )
          return;
        const factory = node.callee.name;
        const parent = node.parent;
        if (
          parent.type !== "VariableDeclarator" ||
          parent.init !== node ||
          parent.id.type !== "Identifier" ||
          parent.parent.kind !== "const"
        ) {
          context.report({ node, messageId: "notBound", data: { factory } });
          return;
        }
        const expected = expectedId(context.filename, parent.id.name);
        if (expected === null) return;
        const arg = node.arguments[0];
        const quoted = JSON.stringify(expected);
        if (arg === undefined) return; // tsc: the id is required.
        if (arg.type !== "Literal" || typeof arg.value !== "string") {
          context.report({
            node: arg,
            messageId: "notLiteral",
            data: { expected: quoted },
            fix: (fixer) => fixer.replaceText(arg, quoted),
          });
          return;
        }
        if (arg.value !== expected) {
          context.report({
            node: arg,
            messageId: "mismatch",
            data: { actual: JSON.stringify(arg.value), expected: quoted },
            fix: (fixer) => fixer.replaceText(arg, quoted),
          });
        }
      },
    };
  },
});
