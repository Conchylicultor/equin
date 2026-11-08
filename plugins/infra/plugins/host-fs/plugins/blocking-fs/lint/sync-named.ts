import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import {
  blockingAt,
  HELPER_FOLDER,
  isSyncReference,
  repoRelative,
  type Blocking,
} from "./blocking";

const createRule = lintRuleCreator(import.meta.url);

/** Any repo `*Sync` counts inside a helper: core imports core, shared core. */
const ANY_REPO_FOLDER = /^/;

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

/**
 * The name a blocking call is charged to: the nearest enclosing function that
 * is not a callback (a function passed as an argument runs on its caller's
 * behalf, so `paths.map((p) => readFileSync(p))` is its enclosing function's
 * work), named by its declaration, its method / property / field key or the
 * variable it initializes. `anonymous` for a function with none (returned,
 * exported as default, in an array), `constructor` for a class constructor,
 * `module` at module scope — except a function handed on by reference there,
 * charged to the variable its wrapper initializes.
 */
type Owner =
  | { kind: "named"; name: string; node: TSESTree.Node }
  | { kind: "anonymous" | "constructor" | "module" };

function ownerOf(node: TSESTree.Node, isReference: boolean): Owner {
  for (let n = node.parent; n != null; n = n.parent) {
    if (
      n.type !== "FunctionDeclaration" &&
      n.type !== "FunctionExpression" &&
      n.type !== "ArrowFunctionExpression"
    )
      continue;
    const fn: FunctionNode = n;
    if (fn.type === "FunctionDeclaration")
      return fn.id === null
        ? { kind: "anonymous" }
        : { kind: "named", name: fn.id.name, node: fn.id };
    const parent = fn.parent;
    if (
      (parent.type === "CallExpression" || parent.type === "NewExpression") &&
      parent.arguments.includes(fn)
    )
      continue;
    if (fn.type === "FunctionExpression" && fn.id !== null)
      return { kind: "named", name: fn.id.name, node: fn.id };
    if (parent.type === "MethodDefinition")
      return parent.kind === "constructor"
        ? { kind: "constructor" }
        : keyOwner(parent.key);
    if (parent.type === "Property" || parent.type === "PropertyDefinition")
      return keyOwner(parent.key);
    if (parent.type === "VariableDeclarator")
      return parent.id.type === "Identifier"
        ? { kind: "named", name: parent.id.name, node: parent.id }
        : { kind: "anonymous" };
    return { kind: "anonymous" };
  }
  // A function handed on by reference at module scope wraps it into the
  // variable it initializes (`export const readFileSync = timed(…,
  // fs.readFileSync)`): that variable is the blocking function.
  if (isReference)
    for (let n = node.parent; n != null; n = n.parent)
      if (n.type === "VariableDeclarator")
        return n.id.type === "Identifier"
          ? { kind: "named", name: n.id.name, node: n.id }
          : { kind: "anonymous" };
  return { kind: "module" };
}

function keyOwner(key: TSESTree.Node): Owner {
  if (key.type === "Identifier" || key.type === "PrivateIdentifier")
    return { kind: "named", name: key.name, node: key };
  if (key.type === "Literal" && typeof key.value === "string")
    return { kind: "named", name: key.value, node: key };
  return { kind: "anonymous" };
}

/**
 * sync-named
 *
 * In a plugin's `core/`, `shared/` or `data-dirs/` folder — code a backend
 * imports that also serves the CLI, checks and scripts, so the folder cannot
 * say which thread runs it — a function that blocks its thread is named
 * `*Sync`, node's own convention. Blocking = it calls (or hands on by
 * reference) a `node:fs` / `node:child_process` `*Sync`, `Bun.resolveSync`
 * / `scanSync` / `spawnSync`, or another repo `*Sync` — so the name climbs
 * through every helper that wraps one.
 *
 * The name is what `blocking-fs/no-sync-fs` reads at a backend's call site:
 * a declaration, so the lint cache (keyed on the declarations a file sees,
 * never another file's body) re-checks every caller when a helper starts or
 * stops blocking. A constructor, a module-scope statement or an anonymous
 * function has no name to carry it: move the blocking work into a named
 * `*Sync` function.
 */
export default createRule({
  name: "sync-named",
  meta: {
    type: "problem",
    docs: {
      description:
        "A core/, shared/ or data-dirs/ function that blocks its thread (sync fs, a sync child process, another *Sync helper) is named *Sync, so blocking-fs/no-sync-fs can refuse it on a backend.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      rename:
        "`{{owner}}` blocks its thread (`{{name}}`): name it `{{owner}}Sync`. This helper serves backends too, and `blocking-fs/no-sync-fs` refuses a backend's call to a `*Sync` — so a backend calls an async twin instead, and the CLI keeps the sync one.",
      unnamed:
        "`{{name}}` blocks its thread in {{where}}, which has no name to say so: move it into a named `*Sync` function (a backend calling this helper cannot be refused otherwise).",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!HELPER_FOLDER.test(repoRelative(context.filename, context.cwd)))
      return {};
    const services = ESLintUtils.getParserServices(context);

    const charge = (
      node: TSESTree.Node,
      hit: Blocking,
      isReference: boolean,
    ) => {
      const owner = ownerOf(node, isReference);
      if (owner.kind === "named") {
        if (!owner.name.endsWith("Sync"))
          context.report({
            node,
            messageId: "rename",
            data: { owner: owner.name, name: hit.name },
          });
        return;
      }
      context.report({
        node,
        messageId: "unnamed",
        data: {
          name: hit.name,
          where:
            owner.kind === "module"
              ? "module scope"
              : owner.kind === "constructor"
                ? "a constructor"
                : "an anonymous function",
        },
      });
    };

    const call = (node: TSESTree.CallExpression) => {
      const hit = blockingAt(node, services, ANY_REPO_FOLDER);
      if (hit !== undefined) charge(node.callee, hit, false);
    };
    const reference = (
      node: TSESTree.Identifier | TSESTree.MemberExpression,
    ) => {
      if (!isSyncReference(node)) return;
      const hit = blockingAt(node, services, ANY_REPO_FOLDER);
      if (hit !== undefined) charge(node, hit, true);
    };

    return {
      CallExpression: call,
      Identifier: reference,
      MemberExpression: reference,
    };
  },
});
