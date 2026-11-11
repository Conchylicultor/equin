import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { domReads, unwrapTsCasts } from "./dom-reads";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Scopes whose bodies are NOT executed during module evaluation. A reference
 * inside one of these is deferred to call time, which is exactly what we want
 * authors to do — so it is never reported.
 *
 * `class-field-initializer` runs per-construction, not at class definition, so
 * it is deferred too — except a `static` field's, which the scope manager files
 * under the same type but which runs at class definition (`isStaticField`). A
 * `class-static-block` genuinely runs at module eval and is deliberately absent
 * from this list.
 */
const DEFERRED_SCOPE_TYPES = new Set([
  "function",
  "function-expression-name",
  "class-field-initializer",
]);

/** Is this `class-field-initializer` scope a `static` field's (run at class definition)? */
function isStaticField(scope: TSESLint.Scope.Scope): boolean {
  const field = (scope.block as TSESTree.Node).parent;
  return (
    (field?.type === "PropertyDefinition" ||
      field?.type === "AccessorProperty") &&
    field.static
  );
}

/** Only `plugins/<…>/web/<…>` files — the runtime-mixed ones. */
const WEB_FILE = /(?:^|\/)plugins\/.*\/web\//;

function isNamed(n: TSESTree.Node, name: string): boolean {
  return n.type === "Identifier" && n.name === name;
}

/** Does `node` contain a `typeof <name>` test anywhere inside it? */
function hasTypeofCheck(node: TSESTree.Node, name: string): boolean {
  let found = false;
  const visit = (n: unknown): void => {
    if (found || n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const child of n) visit(child);
      return;
    }
    const candidate = n as TSESTree.Node & { type?: unknown };
    if (typeof candidate.type !== "string") return;
    if (
      candidate.type === "UnaryExpression" &&
      candidate.operator === "typeof" &&
      isNamed(unwrapTsCasts(candidate.argument), name)
    ) {
      found = true;
      return;
    }
    for (const [key, value] of Object.entries(candidate)) {
      if (key === "parent") continue;
      visit(value);
    }
  };
  visit(node);
  return found;
}

/**
 * Is this reference either the operand of a `typeof`, or lexically inside a
 * branch that a `typeof <name>` test guards? Such a read degrades to a skipped
 * branch (or `false`) off-browser rather than throwing, so it is allowed.
 */
function isTypeofGuarded(identifier: TSESTree.Node, name: string): boolean {
  let node: TSESTree.Node = identifier;
  let parent: TSESTree.Node | undefined = identifier.parent;

  while (parent) {
    if (parent.type === "UnaryExpression" && parent.operator === "typeof")
      return true;

    if (
      (parent.type === "IfStatement" ||
        parent.type === "ConditionalExpression") &&
      node !== parent.test &&
      hasTypeofCheck(parent.test, name)
    ) {
      return true;
    }

    if (
      parent.type === "LogicalExpression" &&
      (parent.operator === "&&" || parent.operator === "??") &&
      node === parent.right &&
      hasTypeofCheck(parent.left, name)
    ) {
      return true;
    }

    node = parent;
    parent = parent.parent;
  }
  return false;
}

export default createRule({
  name: "no-module-scope-dom",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading browser globals during module evaluation in web/ " +
        "files — it makes the module unimportable in any non-DOM runtime.",
    },
    schema: [],
    messages: {
      moduleScopeDom:
        "`{{name}}` is read at module scope, so it runs the moment this file is " +
        "imported. That makes every module that imports it unloadable in a " +
        "runtime without a DOM — `bun test` and the docgen barrel walk both die " +
        "with `ReferenceError: {{name}} is not defined` before any component " +
        "renders. Move the read inside the function, hook, or component that " +
        "needs it (for a socket, open it on the subtree's transport — " +
        "`useTransport()` from @plugins/primitives/plugins/networking/web), or guard it with " +
        '`typeof {{name}} !== "undefined"` if it is a fire-and-forget ' +
        "module-scope side effect.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!WEB_FILE.test(context.filename.replaceAll("\\", "/"))) return {};

    return {
      "Program:exit"(): void {
        // Every runtime read of a browser global, casts included
        // (`(window as X).foo`, `document!`) — the detector no-render-time-dom
        // shares, so the two rules agree on what a DOM read is.
        for (const { identifier, name, from } of domReads(context.sourceCode)) {
          let deferred = false;
          for (let s: typeof from | null = from; s; s = s.upper) {
            if (
              DEFERRED_SCOPE_TYPES.has(s.type) &&
              !(s.type === "class-field-initializer" && isStaticField(s))
            ) {
              deferred = true;
              break;
            }
          }
          if (deferred) continue;
          if (isTypeofGuarded(identifier, name)) continue;

          context.report({
            node: identifier,
            messageId: "moduleScopeDom",
            data: { name },
          });
        }
      },
    };
  },
});
