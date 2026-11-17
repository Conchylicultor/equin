// loss-detector's build-time contribution: stamp every repo component that can
// hold React state with the repo file it is defined in.
//
// The dev unmount detector judges a component's useState / useReducer only
// when the component is the repo's own: a library's internals (base-ui's
// popover keeping `true` after it closed, a floating-ui tree) are not state
// the repo can keep, and reporting them made every report suspect. In a
// production build a fiber says nothing about where its component came from
// — no `_debugSource`, no owner — so the build says it: after each component
// definition that calls a hook it adds
//
//   Name.__equinSource = "plugins/…/file.tsx";
//
// and the detector reads that stamp off the fiber's type (`web/internal/fiber.ts`,
// `componentSource`). Only repo modules go through the artifact builder's Babel
// pass (node_modules never does), so a library component has no stamp by
// construction — no list of library names to keep.
//
// What is stamped — the components rules-of-hooks lets call a hook:
// - `function Name() {…}` (exported or not, at any depth): the binding `Name`;
// - `const Name = () => {…}` / `= function () {…}`: the binding `Name`;
// - `const Name = memo(…)` / `forwardRef(…)` (nested, `React.`-qualified):
//   the binding `Name` — the memo / forwardRef object, which a fiber holds as
//   its `type` or `elementType` (the detector reads both).
// Name is PascalCase; the function's own body (nested functions excluded)
// calls a hook (`use<Upper|digit>…` / `use(…)`). A component calling no hook
// holds no state, so it needs no stamp.
//
// Presence of this folder == presence of the stamps: removing the
// loss-detector removes the `vite/` folder and the discovery walk finds
// nothing.
//
// CONSTRAINTS — kept fully self-contained (single file, no sibling imports) and
// with ZERO `@plugins` / `@babel/*` imports on purpose: this module is loaded
// by a runtime dynamic `import()` of its absolute path, where neither the
// `@plugins` alias nor extensionless `.ts` sibling resolution is available.
// Only `node:path` is imported; the babel `types` factory is handed in at
// runtime. The property name is mirrored by `COMPONENT_SOURCE_PROP` in
// `web/internal/fiber.ts`; a test asserts they agree.

import { relative, sep } from "node:path";

/** The property the stamp sets on a component (mirrored in `web/internal/fiber.ts`). */
const COMPONENT_SOURCE_PROP = "__equinSource";

// A hook call always spells `use<Upper|digit>` (or is React's `use`).
const HOOK_TOKEN_RE = /\buse[A-Z0-9(]/;
const HOOK_NAME_RE = /^use([A-Z0-9].*)?$/;
const COMPONENT_NAME_RE = /^[A-Z]/;
const WRAPPERS: ReadonlySet<string> = new Set(["memo", "forwardRef"]);

// Minimal structural types for the babel surface we touch (we don't import
// `@babel/types`, see CONSTRAINTS above).
interface Node {
  type: string;
  [key: string]: unknown;
}
interface NodePath {
  node: Node;
  parent: Node;
  parentPath: NodePath | null;
  isFunction(): boolean;
  skip(): void;
  getStatementParent(): NodePath | null;
  insertAfter(node: Node): unknown;
  traverse(visitor: Record<string, (path: NodePath) => void>): void;
}
interface BabelTypes {
  expressionStatement(expression: Node): Node;
  assignmentExpression(op: "=", left: Node, right: Node): Node;
  memberExpression(object: Node, property: Node): Node;
  identifier(name: string): Node;
  stringLiteral(value: string): Node;
}
interface PluginPass {
  filename?: string | null;
}

function identifierName(node: unknown): string | undefined {
  const n = node as Node | null | undefined;
  return n?.type === "Identifier" && typeof n.name === "string"
    ? n.name
    : undefined;
}

/** `memo` / `forwardRef`, bare or as a member (`React.memo`). */
function isWrapperCall(node: Node): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee as Node;
  const name =
    callee.type === "MemberExpression"
      ? identifierName(callee.property)
      : identifierName(callee);
  return name !== undefined && WRAPPERS.has(name);
}

/** The callee's name of a call: `useX(…)`, `React.useX(…)`. */
function calleeName(node: Node): string | undefined {
  const callee = node.callee as Node;
  return callee.type === "MemberExpression"
    ? identifierName(callee.property)
    : identifierName(callee);
}

/** Whether the function's own body (nested functions excluded) calls a hook. */
function callsHook(fn: NodePath): boolean {
  let found = false;
  fn.traverse({
    Function(inner) {
      inner.skip();
    },
    CallExpression(call) {
      const name = calleeName(call.node);
      if (name !== undefined && HOOK_NAME_RE.test(name)) found = true;
    },
  });
  return found;
}

/**
 * The binding a component function is stamped through, and the statement the
 * stamp goes after — or null for a function that is no component binding.
 */
function stampTarget(fn: NodePath): { name: string; after: NodePath } | null {
  const node = fn.node;
  if (node.type === "FunctionDeclaration") {
    const name = identifierName(node.id);
    if (name === undefined || !COMPONENT_NAME_RE.test(name)) return null;
    return withStatement(name, fn.getStatementParent());
  }
  // A function expression: climb through memo / forwardRef calls to the
  // declarator binding it.
  let path: NodePath | null = fn.parentPath;
  while (path !== null && isWrapperCall(path.node)) path = path.parentPath;
  if (path === null || path.node.type !== "VariableDeclarator") return null;
  const name = identifierName(path.node.id);
  if (name === undefined || !COMPONENT_NAME_RE.test(name)) return null;
  return withStatement(name, path.getStatementParent());
}

/** The stamp goes after the whole statement — an `export …` around a declaration included. */
function withStatement(
  name: string,
  statement: NodePath | null,
): { name: string; after: NodePath } | null {
  if (statement === null) return null;
  const parent = statement.parentPath;
  const after =
    parent !== null &&
    (parent.node.type === "ExportNamedDeclaration" ||
      parent.node.type === "ExportDefaultDeclaration")
      ? parent
      : statement;
  return { name, after };
}

/**
 * Factory consumed by the artifact builder. `repoRoot` makes the stamped path
 * repo-relative. `appliesTo` is exact: a module naming no hook has no
 * component to stamp.
 */
export default function componentSourceBabelPlugin({
  repoRoot,
}: {
  repoRoot: string;
}) {
  return {
    appliesTo: ({ code }: { id: string; code: string }) =>
      HOOK_TOKEN_RE.test(code),
    plugin: componentSourceInner,
  };
  function componentSourceInner({ types: t }: { types: BabelTypes }) {
    // One stamp per binding and statement, however many functions resolve to it.
    const stamped = new WeakMap<Node, Set<string>>();
    return {
      name: "loss-detector-component-source",
      visitor: {
        Function(fn: NodePath, state: PluginPass) {
          const filename = state.filename;
          if (!filename) return;
          const target = stampTarget(fn);
          if (target === null) return;
          let names = stamped.get(target.after.node);
          if (names?.has(target.name)) return;
          if (!callsHook(fn)) return;
          if (names === undefined)
            stamped.set(target.after.node, (names = new Set()));
          names.add(target.name);
          const file = relative(repoRoot, filename.split("?")[0]!)
            .split(sep)
            .join("/");
          target.after.insertAfter(
            t.expressionStatement(
              t.assignmentExpression(
                "=",
                t.memberExpression(
                  t.identifier(target.name),
                  t.identifier(COMPONENT_SOURCE_PROP),
                ),
                t.stringLiteral(file),
              ),
            ),
          );
        },
      },
    };
  }
}
