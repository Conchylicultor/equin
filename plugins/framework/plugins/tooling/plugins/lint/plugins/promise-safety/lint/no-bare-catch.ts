import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

function isConsoleErrorOrWarnCall(node: TSESTree.Expression): boolean {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "console" &&
    node.callee.property.type === "Identifier" &&
    (node.callee.property.name === "error" ||
      node.callee.property.name === "warn")
  );
}

function isConsoleErrorOrWarnStatement(node: TSESTree.Statement): boolean {
  return (
    node.type === "ExpressionStatement" &&
    isConsoleErrorOrWarnCall(node.expression)
  );
}

export default createRule({
  name: "no-bare-catch",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow .catch() and catch blocks that silently swallow errors.",
    },
    schema: [],
    messages: {
      empty:
        "Empty .catch() silently swallows errors — this hides bugs. " +
        "Handle the specific exception and re-throw unknown errors, " +
        "or remove the .catch() and use `void promise` if fire-and-forget is intentional " +
        "(the reports plugin automatically captures unhandled rejections and files tasks). " +
        "See CLAUDE.md § Promise handling.",
      consoleOnly:
        ".catch(console.error/warn) logs the error but swallows the rejection — " +
        "the caller sees success and the bug becomes invisible. " +
        "Remove the .catch() and use `void promise` — the reports plugin captures " +
        "unhandled rejections automatically and files tasks. " +
        "If local handling is needed, catch specific exceptions and re-throw unknown ones. " +
        "See CLAUDE.md § Promise handling.",
      emptyCatch:
        "Empty catch block silently swallows errors — this hides bugs. " +
        "Handle the specific exception and re-throw unknown errors. " +
        "Unhandled exceptions are automatically captured by the reports plugin. " +
        "See CLAUDE.md § Promise handling.",
      consoleOnlyCatch:
        "catch block with only console.error/warn logs the error but swallows it — " +
        "the bug becomes invisible. Re-throw after logging, or remove the try/catch " +
        "entirely — the reports plugin automatically captures uncaught exceptions " +
        "and files tasks. See CLAUDE.md § Promise handling.",
      swallowingCatch:
        "Parameterless `catch {` silently swallows the error — with no binding the " +
        "handler cannot inspect or re-throw it, so unexpected failures vanish. " +
        "Fail loudly instead: add a binding and re-throw everything you don't " +
        "specifically expect — `catch (err) { if (!isExpected(err)) throw err; … }`. " +
        "The reports plugin captures uncaught exceptions automatically. Swallowing " +
        "all errors is a last resort: only when any propagation would be wrong " +
        "(best-effort cleanup / teardown), and you must say why with " +
        "`// eslint-disable-next-line promise-safety/no-bare-catch -- <why all errors are safe to drop here>`. " +
        "See CLAUDE.md § Promise handling.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      "CallExpression[callee.property.name='catch']"(
        node: TSESTree.CallExpression,
      ) {
        const arg = node.arguments[0];
        if (!arg) return;

        // .catch(() => {}) or .catch(function() {})
        if (
          (arg.type === "ArrowFunctionExpression" ||
            arg.type === "FunctionExpression") &&
          arg.body.type === "BlockStatement" &&
          arg.body.body.length === 0
        ) {
          context.report({ node, messageId: "empty" });
          return;
        }

        // .catch(console.error) or .catch(console.warn)
        if (
          arg.type === "MemberExpression" &&
          arg.object.type === "Identifier" &&
          arg.object.name === "console" &&
          arg.property.type === "Identifier" &&
          (arg.property.name === "error" || arg.property.name === "warn")
        ) {
          context.report({ node, messageId: "consoleOnly" });
          return;
        }

        // .catch(e => console.error(e)) — expression body
        if (
          arg.type === "ArrowFunctionExpression" &&
          arg.body.type !== "BlockStatement" &&
          isConsoleErrorOrWarnCall(arg.body)
        ) {
          context.report({ node, messageId: "consoleOnly" });
          return;
        }

        // .catch(e => { console.error(e) }) or .catch(function(e) { console.error(e) })
        if (
          (arg.type === "ArrowFunctionExpression" ||
            arg.type === "FunctionExpression") &&
          arg.body.type === "BlockStatement" &&
          arg.body.body.length > 0 &&
          arg.body.body.every(isConsoleErrorOrWarnStatement)
        ) {
          context.report({ node, messageId: "consoleOnly" });
          return;
        }
      },

      // try/catch — empty or console-only catch blocks
      CatchClause(node: TSESTree.CatchClause) {
        if (node.body.body.length === 0) {
          context.report({ node, messageId: "emptyCatch" });
          return;
        }

        if (node.body.body.every(isConsoleErrorOrWarnStatement)) {
          context.report({ node, messageId: "consoleOnlyCatch" });
          return;
        }

        // A binding-less catch provably cannot inspect or re-throw the original
        // error — it is definitionally swallowing it, regardless of body shape.
        if (node.param === null) {
          context.report({ node, messageId: "swallowingCatch" });
        }
      },
    };
  },
});
