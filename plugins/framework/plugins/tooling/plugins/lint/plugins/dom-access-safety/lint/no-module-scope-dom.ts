import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * Globals that exist only in a browser. Reading any of them while a module is
 * being evaluated throws in every other runtime.
 */
const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "matchMedia",
]);

/**
 * Scopes whose bodies are NOT executed during module evaluation. A reference
 * inside one of these is deferred to call time, which is exactly what we want
 * authors to do — so it is never reported.
 *
 * `class-field-initializer` runs per-construction, not at class definition, so
 * it is deferred too. A `class-static-block` genuinely runs at module eval and
 * is deliberately absent from this list.
 */
const DEFERRED_SCOPE_TYPES = new Set([
  "function",
  "function-expression-name",
  "class-field-initializer",
]);

/** Only `plugins/<…>/web/<…>` files — the runtime-mixed ones. */
const WEB_FILE = /(?:^|\/)plugins\/.*\/web\//;

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
      candidate.argument.type === "Identifier" &&
      candidate.argument.name === name
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
function isTypeofGuarded(
  identifier: TSESTree.Identifier,
  name: string,
): boolean {
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

/** TS type positions (`typeof window` in a type query) emit no runtime read. */
function isInTypePosition(identifier: TSESTree.Identifier): boolean {
  let parent: TSESTree.Node | undefined = identifier.parent;
  while (parent) {
    if (parent.type.startsWith("TS")) return true;
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
        const { scopeManager } = context.sourceCode;
        const globalScope = scopeManager?.globalScope;
        if (!globalScope) return;

        // `through` holds every reference the file never resolved locally — i.e.
        // the globals. A file that declares its own `document` resolves it and
        // is correctly silent.
        for (const ref of globalScope.through) {
          const name = ref.identifier.name;
          if (!BROWSER_GLOBALS.has(name)) continue;

          let deferred = false;
          for (let s: typeof ref.from | null = ref.from; s; s = s.upper) {
            if (DEFERRED_SCOPE_TYPES.has(s.type)) {
              deferred = true;
              break;
            }
          }
          if (deferred) continue;

          const identifier = ref.identifier as TSESTree.Identifier;
          if (isInTypePosition(identifier)) continue;
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
