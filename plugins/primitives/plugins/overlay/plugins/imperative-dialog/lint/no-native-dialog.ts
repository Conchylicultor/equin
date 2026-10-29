import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { TSESLint } from "@typescript-eslint/utils";

/**
 * no-native-dialog
 *
 * Bans the native browser modals `confirm(x)` / `alert(x)` / `prompt(x)`: they
 * block the main thread with an unstyled OS chrome (no theme, no pending state,
 * invisible to Playwright). Use `confirmDialog` for a yes/no guard, or
 * `openDialog` for a richer body — both from the imperative-dialog primitive.
 *
 * Detection is SCOPE-precise, never name-based:
 *
 * (1) A bare call `confirm(x)` / `alert(x)` / `prompt(x)` fires ONLY when the
 *     callee identifier resolves to NO binding in any enclosing scope — i.e. it
 *     is the ambient global. `prompt` in particular is an endemic LOCAL name in
 *     this repo (props, params, helpers: the llm-prompt step, prompt-editor,
 *     claude-cli), so matching by name alone would be a storm of false
 *     positives. The rule runs at `error`, so a false positive BREAKS THE BUILD
 *     — it therefore favors false negatives.
 *
 * (2) A member call `window.confirm(x)` / `globalThis.alert(x)` / `self.prompt(x)`
 *     fires when the object is a bare identifier in {window, globalThis, self},
 *     the access is non-computed, and the property is in the banned set. This
 *     deliberately does NOT match `document.foo.confirm()` (object is a
 *     MemberExpression), `dialogs.confirm()` (object not a global name), or
 *     `window["confirm"](x)` (computed).
 *
 * Same scope walk as pane/no-hint-fabrication.
 */

const createRule = lintRuleCreator(import.meta.url);

const BANNED = new Set(["confirm", "alert", "prompt"]);
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self"]);

type Ctx = Readonly<TSESLint.RuleContext<"nativeDialog", []>>;

/**
 * True iff `ident` resolves to NO binding in any enclosing scope — i.e. it is the
 * ambient global. Same scope walk as pane/no-hint-fabrication. Erring toward NOT
 * reporting: any local/imported/parameter binding of the same name returns false.
 */
function resolvesToGlobal(context: Ctx, ident: TSESTree.Identifier): boolean {
  let scope: TSESLint.Scope.Scope | null = context.sourceCode.getScope(ident);
  while (scope) {
    if (scope.variables.some((v) => v.name === ident.name)) return false;
    scope = scope.upper;
  }
  return true;
}

export default createRule({
  name: "no-native-dialog",
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban native confirm()/alert()/prompt(): they block the event loop and are unthemed. Use confirmDialog / openDialog.",
    },
    schema: [],
    messages: {
      nativeDialog:
        "Native `{{name}}()` blocks the main thread with an unstyled browser modal (no theme, no pending state, invisible to Playwright). Use `confirmDialog` from @plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web for a yes/no guard, or `openDialog` from @plugins/primitives/plugins/overlay/plugins/imperative-dialog/web for a richer body.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === AST_NODE_TYPES.Identifier &&
          BANNED.has(callee.name) &&
          resolvesToGlobal(context, callee)
        ) {
          context.report({
            node,
            messageId: "nativeDialog",
            data: { name: callee.name },
          });
          return;
        }
        if (
          callee.type === AST_NODE_TYPES.MemberExpression &&
          !callee.computed &&
          callee.object.type === AST_NODE_TYPES.Identifier &&
          GLOBAL_OBJECTS.has(callee.object.name) &&
          callee.property.type === AST_NODE_TYPES.Identifier &&
          BANNED.has(callee.property.name)
        ) {
          context.report({
            node,
            messageId: "nativeDialog",
            data: { name: callee.property.name },
          });
        }
      },
    };
  },
});
