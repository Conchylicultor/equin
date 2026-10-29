import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A picker whose options come from `useConfig(descriptor)` carries an implicit
 * obligation: surface a "configure" gear that jumps to that config (the
 * descriptor self-identifies its settings location). The gear
 * (`ConfigGearButton` / header) is a manual add-on today, so two surfaces
 * reading the same kind of config diverge — one shows the gear, the other
 * forgets it.
 *
 * `config-link` ships config-aware menu chrome — `ConfigSelectContent` /
 * `ConfigMenuContent` (`@plugins/config_v2/plugins/config-link/web`) — that bake
 * the gear into the container so a config-backed picker literally cannot render
 * without it. This rule flags the raw ui-kit `SelectContent` /
 * `DropdownMenuContent` when they appear inside a component that reads a config
 * via `useConfig`, steering authors to the wrappers.
 *
 * Heuristic (intentionally low false-positive): only fire when BOTH
 *   (1) the JSX tag's local name resolves to the ui-kit barrel import, AND
 *   (2) a `useConfig(...)` call (bound to the `@plugins/config_v2/web` import)
 *       appears in the enclosing function.
 * A raw Select in a component that never calls `useConfig` is left alone.
 */
const UI_KIT_SOURCE = "@plugins/primitives/plugins/css/plugins/ui-kit/web";
const CONFIG_V2_SOURCE = "@plugins/config_v2/web";

/** Maps each flaggable ui-kit container to its config-aware wrapper. */
const WRAPPERS: Record<string, string> = {
  SelectContent: "ConfigSelectContent",
  DropdownMenuContent: "ConfigMenuContent",
};

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

function isFunctionNode(node: TSESTree.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** Walk up to the nearest enclosing function (component) node, if any. */
function enclosingFunction(node: TSESTree.Node): FunctionNode | undefined {
  let cur: TSESTree.Node | undefined = node.parent;
  while (cur) {
    if (isFunctionNode(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

export default createRule({
  name: "no-unlinked-config-picker",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw ui-kit SelectContent/DropdownMenuContent inside a component that reads a config_v2 descriptor via useConfig — use ConfigSelectContent/ConfigMenuContent so the configure-gear is guaranteed.",
    },
    schema: [],
    messages: {
      unlinkedPicker:
        "`{{tag}}` is config-backed (this component calls `useConfig`), but the raw ui-kit container has no configure-gear. Use `{{wrapper}}` from @plugins/config_v2/plugins/config-link/web, passing the same `descriptor` you read with `useConfig` — the gear lives inside its chrome, so it can't be forgotten. If this Select genuinely isn't config-backed, add `// eslint-disable-next-line config-link/no-unlinked-config-picker -- reason`.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Track which local names of interest were imported from which barrel, so
    // an unrelated `SelectContent` (or `useConfig`) from elsewhere never fires.
    // localName -> canonical ui-kit import name (handles `as` aliases).
    const uiKitLocals = new Map<string, string>();
    let useConfigLocal: string | undefined;

    // Functions whose body contains a `useConfig(...)` call bound to config_v2.
    const configFns = new Set<FunctionNode>();
    // Raw ui-kit containers we saw, deferred until imports + useConfig calls are
    // fully collected (a single top-down pass can't know either yet).
    const pending: Array<{
      node: TSESTree.JSXOpeningElement;
      tag: string;
      fn: FunctionNode;
    }> = [];

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        const source = node.source.value;
        if (source !== UI_KIT_SOURCE && source !== CONFIG_V2_SOURCE) return;
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier") continue;
          if (spec.imported.type !== "Identifier") continue;
          const imported = spec.imported.name;
          const local = spec.local.name;
          if (source === UI_KIT_SOURCE && imported in WRAPPERS) {
            uiKitLocals.set(local, imported);
          } else if (source === CONFIG_V2_SOURCE && imported === "useConfig") {
            useConfigLocal = local;
          }
        }
      },

      CallExpression(node: TSESTree.CallExpression) {
        if (
          node.callee.type !== "Identifier" ||
          useConfigLocal === undefined ||
          node.callee.name !== useConfigLocal
        )
          return;
        const fn = enclosingFunction(node);
        if (fn) configFns.add(fn);
      },

      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        if (node.name.type !== "JSXIdentifier") return;
        const canonical = uiKitLocals.get(node.name.name);
        if (canonical === undefined) return;
        const fn = enclosingFunction(node);
        if (!fn) return;
        pending.push({ node, tag: canonical, fn });
      },

      "Program:exit"() {
        for (const { node, tag, fn } of pending) {
          if (!configFns.has(fn)) continue;
          context.report({
            node,
            messageId: "unlinkedPicker",
            data: { tag, wrapper: WRAPPERS[tag] },
          });
        }
      },
    };
  },
});
