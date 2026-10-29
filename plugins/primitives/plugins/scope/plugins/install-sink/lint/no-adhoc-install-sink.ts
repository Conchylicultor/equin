import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

/**
 * no-adhoc-install-sink
 *
 * Bans the hand-rolled INSTALLED SINK that never reaches the primitive and that
 * offers NO WAY TO SUBSCRIBE — exactly the shape that produced the incident:
 *
 *   let appNavigator = null;                                   // ← the slot
 *   export function setAppNavigator(fn) { appNavigator = fn; } // ← late install
 *   export function canNavigateApp() { return appNavigator !== null; } // ← read
 *
 * An installed sink is a module-level slot a higher layer installs into and a
 * lower layer calls (the codebase's answer to "tabs imports pane, so pane cannot
 * import tabs"). Installation happens at provider mount — inside an EFFECT, one
 * commit AFTER the first render of everything mounted alongside it. When the
 * file offers only an imperative read, a consumer that reads during render
 * samples the slot before anything is in it and, with nothing to subscribe to
 * and the slot in no dependency array, caches that pre-install answer forever.
 *
 * `defineInstallSink` owns the slot, the subscriber set, the `useInstalled()` /
 * `useValue()` hooks that make the render path reactive, and names its
 * imperative read `peek…` so the companion rules can see it at every call site.
 *
 * DETECTION — deliberately narrow (plugin rules run repo-wide as `error`, so a
 * false positive breaks the build). ALL of:
 *
 *   0. The file is in the WEB runtime (a `web/` path segment). See below.
 *   1. The file has NO SUBSCRIPTION PATH — none of: a `useSyncExternalStore`
 *      call; an EXPORTED function named `/^subscribe/`; a `new Set<() => void>()`
 *      listener collection (either spelling of the type: the `new Set<…>()` type
 *      argument or the declaration's `: Set<…>` annotation). Any one of those
 *      means the file's readers CAN subscribe, so it is not this shape.
 *   2. An EXPORTED module-scope function named `/^(set|install|register)[A-Z]/`
 *      assigns to a module-scope `let`/`var` binding.
 *   3. That binding is READ somewhere outside that writer function — another
 *      function in the file, or module scope. A write-only binding is a
 *      configuration slot nobody consumes here, not a sink.
 *
 * We report on the declaration.
 *
 * WHY THE WEB-RUNTIME GUARD (0), AND WHAT IT DELIBERATELY MISSES. Everything
 * this rule says is about RENDER: a consumer that reads the slot during render
 * caches the pre-install answer and nothing re-runs the check. A `server/`,
 * `core/` or build-time module has no render path, so firing there would make
 * the message a lie and cost a disable comment on ~17 slots the primitive is not
 * for. The accepted false negative: a sink DECLARED in `core/` (or `shared/`)
 * and read from render in a web file is missed. That is the trade for a rule
 * whose message is true everywhere it fires — and the render-side half of such a
 * slot is still covered by `no-render-phase-peek` / `no-laundered-peek`.
 *
 * WHY (1) IS "ANY subscription path", not just `useSyncExternalStore`. A store
 * split across a store file (the value, the listener `Set`, an exported
 * `subscribe…`) and a consumer file (the `useSyncExternalStore` call) has a
 * perfectly good subscription path that a file-local test cannot see —
 * `improve/web/internal/open-store.ts` is exactly that. Detection of the
 * listener collection keys on the DECLARED `() => void` element type rather than
 * on how the set is used: an untyped `new Set()` iterated to call its members is
 * inferable only with type information this rule does not have, and a missed
 * exemption is a false POSITIVE — the expensive direction.
 *
 * Escape hatch — a slot that genuinely cannot use the primitive (a boot-time
 * fact read only outside React, or a module the primitive's barrel cannot reach
 * without closing an import cycle) disables this per-site with a reason:
 *
 *   // eslint-disable-next-line install-sink/no-adhoc-install-sink -- <reason>
 */

const createRule = lintRuleCreator(import.meta.url);

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

/** The simple callee name of a call (`f()` → `f`, `a.b()` → `b`), or null. */
function calleeName(node: TSESTree.CallExpression): string | null {
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

/** Does a module-scope `let`/`var` declaration sit directly at `Program` (bare or exported)? */
function isProgramScopeDeclaration(
  decl: TSESTree.VariableDeclaration,
): boolean {
  const parent = decl.parent;
  if (parent.type === "Program") return true;
  if (
    (parent.type === "ExportNamedDeclaration" ||
      parent.type === "ExportDefaultDeclaration") &&
    parent.parent.type === "Program"
  ) {
    return true;
  }
  return false;
}

const WRITER_NAME = /^(set|install|register)[A-Z]/;

/**
 * The web runtime — a `web/` path segment, per the repo's strict runtime-folder
 * convention (`web/` | `server/` | `core/` | `shared/` under each plugin), which
 * also covers the root `web/` bootstrap.
 *
 * Hardcoded rather than derived from `runtimeNames`
 * (`framework/tooling/boundaries/core`): lint rule files are loaded by jiti,
 * which cannot resolve the `@plugins/*` aliases, and a relative hop into another
 * plugin's tree would itself be a boundary violation. One literal segment name
 * is the smaller cost.
 */
const WEB_RUNTIME_FILE = /(?:^|\/)web\//;

/** Is this type node a nullary, void-returning function type — `() => void`? */
function isNullaryVoidFunctionType(
  node: TSESTree.TypeNode | undefined,
): boolean {
  if (!node || node.type !== "TSFunctionType") return false;
  if (node.params.length > 0) return false;
  const ret = node.returnType?.typeAnnotation.type;
  return ret === "TSVoidKeyword" || ret === "TSUnknownKeyword";
}

/** Does a type-argument list read `<() => void>` — the listener-set element type? */
function isListenerTypeArgs(
  args: TSESTree.TSTypeParameterInstantiation | undefined,
): boolean {
  return args !== undefined && isNullaryVoidFunctionType(args.params[0]);
}

export default createRule({
  name: "no-adhoc-install-sink",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a hand-rolled install sink — a module-scope `let`/`var` " +
        "written by an exported `set*`/`install*`/`register*` function and read " +
        "elsewhere, with no subscription path. Use defineInstallSink.",
    },
    schema: [],
    messages: {
      adhocInstallSink:
        "`{{name}}` is an install sink with no way to subscribe: `{{writer}}` " +
        "fills it (at provider mount, i.e. in an effect — a commit after the " +
        "first render) and other code reads it back imperatively. A consumer " +
        "that reads it during render caches the pre-install answer forever, and " +
        "which answer it gets is mount-order luck. Use `defineInstallSink` " +
        "(@plugins/primitives/plugins/scope/plugins/install-sink/web), which owns the " +
        "subscription (`useInstalled()` / `useValue()`) and names its " +
        "imperative read `peek…`. For a slot that genuinely cannot use it, " +
        "disable this rule on the line with a reason " +
        "(`-- <why this cannot subscribe>`).",
    },
  },
  defaultOptions: [],
  create(context) {
    // (0) Only the web runtime — a render path is the whole premise.
    if (!WEB_RUNTIME_FILE.test(context.filename.replaceAll("\\", "/")))
      return {};

    // Module-scope `let`/`var` bindings, by bound name → declaration node.
    const mutableBindings = new Map<string, TSESTree.VariableDeclaration>();
    // Exported module-scope `set*`/`install*`/`register*` functions.
    const writers: { name: string; fn: FunctionNode }[] = [];
    // (1) Any evidence that this file's readers can subscribe.
    let hasSubscriptionPath = false;

    function recordWriterFunction(name: string, fn: FunctionNode): void {
      if (name.startsWith("subscribe")) hasSubscriptionPath = true;
      if (!WRITER_NAME.test(name)) return;
      writers.push({ name, fn });
    }

    return {
      // A `Set<() => void>` of listeners, in either spelling of the type.
      NewExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "Set")
          return;
        if (isListenerTypeArgs(node.typeArguments)) hasSubscriptionPath = true;
      },
      "VariableDeclarator > Identifier"(node: TSESTree.Identifier) {
        const annotation = node.typeAnnotation?.typeAnnotation;
        if (annotation?.type !== "TSTypeReference") return;
        if (annotation.typeName.type !== "Identifier") return;
        if (annotation.typeName.name !== "Set") return;
        if (isListenerTypeArgs(annotation.typeArguments))
          hasSubscriptionPath = true;
      },
      VariableDeclaration(node) {
        if (node.kind !== "let" && node.kind !== "var") return;
        if (!isProgramScopeDeclaration(node)) return;
        for (const decl of node.declarations) {
          if (decl.id.type === "Identifier")
            mutableBindings.set(decl.id.name, node);
        }
      },
      CallExpression(node) {
        if (calleeName(node) === "useSyncExternalStore")
          hasSubscriptionPath = true;
      },
      "ExportNamedDeclaration > FunctionDeclaration"(
        node: TSESTree.FunctionDeclaration,
      ) {
        if (node.parent.parent?.type !== "Program") return;
        if (node.id) recordWriterFunction(node.id.name, node);
      },
      "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator"(
        node: TSESTree.VariableDeclarator,
      ) {
        if (node.parent.parent.parent?.type !== "Program") return;
        if (node.id.type !== "Identifier" || !node.init) return;
        const init = node.init;
        if (
          init.type !== "ArrowFunctionExpression" &&
          init.type !== "FunctionExpression"
        ) {
          return;
        }
        recordWriterFunction(node.id.name, init);
      },
      "Program:exit"() {
        // (1) A file with a subscription path is out of scope.
        if (hasSubscriptionPath) return;
        if (writers.length === 0 || mutableBindings.size === 0) return;

        const scopeManager = context.sourceCode.scopeManager;
        const moduleScope =
          scopeManager?.globalScope?.childScopes.find(
            (s) => s.type === "module",
          ) ?? scopeManager?.globalScope;
        if (!moduleScope) return;

        const reported = new Set<TSESTree.VariableDeclaration>();

        for (const [name, decl] of mutableBindings) {
          if (reported.has(decl)) continue;
          const variable = moduleScope.variables.find((v) => v.name === name);
          if (!variable) continue;

          for (const { name: writerName, fn } of writers) {
            const inWriter = (node: TSESTree.Node): boolean =>
              node.range[0] >= fn.range[0] && node.range[1] <= fn.range[1];

            // (2) The writer assigns to this binding.
            const assigns = variable.references.some(
              (ref) =>
                ref.isWrite() &&
                !ref.init &&
                ref.writeExpr !== undefined &&
                inWriter(ref.identifier as TSESTree.Node),
            );
            if (!assigns) continue;

            // (3) The binding is read outside that writer.
            const readOutside = variable.references.some(
              (ref) =>
                ref.isRead() && !inWriter(ref.identifier as TSESTree.Node),
            );
            if (!readOutside) continue;

            reported.add(decl);
            context.report({
              node: decl,
              messageId: "adhocInstallSink",
              data: { name, writer: writerName },
            });
            break;
          }
        }
      },
    };
  },
});
