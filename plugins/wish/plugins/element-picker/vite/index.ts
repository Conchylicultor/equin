// element-picker's build-time contribution: a source-location Babel plugin.
//
// `web-core/vite.config.ts` discovers every `**/vite/index.ts` generically (it
// never names this plugin) and passes each default export's result to
// `@vitejs/plugin-react`'s `babel.plugins`. The transform stamps host DOM
// elements with `data-source="<file>:<line>"`; the element-picker read side
// emits that as the `source=` attribute on the picked `<ui-context …>` tag, so a
// picked element resolves to the exact `file:line` it renders from — even plain
// JSX with no slot contribution boundary (e.g. a `<button>` inside
// `launch-control.tsx`).
//
// Presence of this folder == presence of the source attributes: removing the
// element-picker plugin removes the `vite/` folder, the glob finds nothing, and
// React runs with no extra babel plugin (no `data-source` stamping).
//
// CONSTRAINTS — kept fully self-contained (single file, no sibling imports) and
// with ZERO `@plugins` / `@babel/*` imports on purpose: this module is loaded by
// `vite.config.ts` via a runtime dynamic `import()` of its absolute path, where
// neither the `@plugins` alias nor extensionless `.ts` sibling resolution is
// available. Only `node:path` is imported; the babel `types` factory is handed in
// at runtime.

import { relative, sep } from "node:path";

// Minimal structural types for the babel surface we touch (we don't import
// `@babel/types`, see CONSTRAINTS above).
interface BabelTypes {
  jsxAttribute(name: JSXIdentifier, value: StringLiteral): JSXAttribute;
  jsxIdentifier(name: string): JSXIdentifier;
  stringLiteral(value: string): StringLiteral;
}
interface JSXIdentifier {
  type: "JSXIdentifier";
  name: string;
}
interface StringLiteral {
  type: "StringLiteral";
}
interface JSXAttribute {
  type: "JSXAttribute";
  name: { type: "JSXIdentifier" | "JSXNamespacedName"; name?: string };
}
interface SourceLocation {
  start: { line: number };
}
interface JSXOpeningElementNode {
  name: { type: string; name?: string };
  attributes: Array<JSXAttribute | { type: string }>;
  loc?: SourceLocation | null;
}
// The enclosing-function node shapes we read to resolve a component name. Loose
// structural types — we don't import `@babel/types` (see CONSTRAINTS above).
interface FunctionParentNode {
  type: string; // FunctionDeclaration | FunctionExpression | ArrowFunctionExpression
  id?: { type?: string; name?: string } | null;
}
interface NamedParentNode {
  type: string; // VariableDeclarator | AssignmentExpression | ...
  id?: { type?: string; name?: string };
  left?: { type?: string; name?: string };
}
interface VisitorPath<N> {
  node: N;
  parentPath?: VisitorPath<NamedParentNode> | null;
  // Nearest ancestor function path (excludes the current path), or null.
  getFunctionParent(): VisitorPath<FunctionParentNode> | null;
}
interface PluginPass {
  filename?: string | null;
}
interface BabelPluginObject {
  name: string;
  visitor: {
    JSXOpeningElement(
      path: VisitorPath<JSXOpeningElementNode>,
      state: PluginPass,
    ): void;
  };
}

const SOURCE_ATTR = "data-source";
const OWNER_ATTR = "data-ui-owner";
const COMPONENT_NAME_RE = /^[A-Z]/;

/** True if the opening element already carries `attrName` (idempotency guard,
 * e.g. across HMR re-transforms). */
function hasAttr(node: JSXOpeningElementNode, attrName: string): boolean {
  for (const attr of node.attributes) {
    if (
      attr.type === "JSXAttribute" &&
      (attr as JSXAttribute).name.type === "JSXIdentifier" &&
      (attr as JSXAttribute).name.name === attrName
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Nearest enclosing *component* function name for a JSX callsite — the semantic
 * owner we attribute the picked element to (e.g. `LaunchControl`). Walks function
 * parents outward, skipping uncapitalized/anonymous functions (`.map()` callbacks,
 * `useX` hooks, event handlers) so a callsite nested inside an inner arrow still
 * resolves to the component that contains it. Returns undefined when no
 * capitalized enclosing function is found (caller keeps just `file:line`).
 */
function enclosingComponentName(
  path: VisitorPath<JSXOpeningElementNode>,
): string | undefined {
  let fn = path.getFunctionParent();
  while (fn) {
    // `function Foo() {}`
    const id = fn.node.id;
    if (
      fn.node.type === "FunctionDeclaration" &&
      id &&
      typeof id.name === "string" &&
      COMPONENT_NAME_RE.test(id.name)
    ) {
      return id.name;
    }
    // `const Foo = () => {}` / `const Foo = function () {}` / `Foo = () => {}`
    const parent = fn.parentPath?.node;
    const named =
      parent?.type === "VariableDeclarator"
        ? parent.id
        : parent?.type === "AssignmentExpression"
          ? parent.left
          : undefined;
    if (
      named &&
      named.type === "Identifier" &&
      typeof named.name === "string" &&
      COMPONENT_NAME_RE.test(named.name)
    ) {
      return named.name;
    }
    fn = fn.getFunctionParent();
  }
  return undefined;
}

/**
 * Factory consumed by the vite config. `repoRoot` lets the transform compute
 * repo-relative paths. Returns a babel plugin function `({ types }) => pluginObj`
 * accepted by `react({ babel: { plugins: [...] } })`, which stamps
 * `data-source="<repo-relative-posix-path>:<line>"` on host JSX elements.
 */
export default function sourceLocationBabelPlugin({
  repoRoot,
}: {
  repoRoot: string;
}) {
  return function sourceLocationBabelPluginInner({
    types: t,
  }: {
    types: BabelTypes;
  }): BabelPluginObject {
    return {
      name: "element-picker-source-location",
      visitor: {
        JSXOpeningElement(path, state) {
          const node = path.node;
          const name = node.name;

          // Only simple JSX identifiers. Skip member expressions (`<Foo.Bar>`,
          // including base-ui `<Menu.Trigger>` which must stay transparent so a
          // forwarded owner rides through it) and namespaced names (`<svg:path>`).
          if (name.type !== "JSXIdentifier" || typeof name.name !== "string") {
            return;
          }

          const filename = state.filename;
          const loc = node.loc;
          if (!filename || !loc) return;
          const rel = relative(repoRoot, filename).split(sep).join("/");

          // Host elements (`<div>`, `<button>`): stamp `data-source` at the leaf.
          if (/^[a-z]/.test(name.name)) {
            if (hasAttr(node, SOURCE_ATTR)) return;
            const value = `${rel}:${loc.start.line}`;
            // APPEND: a leaf host has no competing prop spread for `data-source`.
            node.attributes.push(
              t.jsxAttribute(t.jsxIdentifier(SOURCE_ATTR), t.stringLiteral(value)),
            );
            return;
          }

          // Component callsites (`<LaunchControl>`, `<ButtonGroup>`): stamp
          // `data-ui-owner` with the enclosing component name + callsite. shadcn /
          // base-ui primitives forward unrecognized `data-*` onto their host
          // element, so this rides the composed primitive's `{...props}` spread
          // onto the picked DOM node — naming the composing component (which
          // authors no host element of its own) rather than just the leaf
          // primitive `data-source` points at. `Fragment` accepts no DOM props, so
          // skip it (avoids a dev-mode React invalid-prop warning).
          if (name.name === "Fragment" || hasAttr(node, OWNER_ATTR)) return;
          const owner = enclosingComponentName(path);
          const value = owner
            ? `${owner}@${rel}:${loc.start.line}`
            : `${rel}:${loc.start.line}`;
          // PREPEND: placed before any `{...props}` spread so a forwarded outer
          // owner (from a higher composing component) overrides this inner one —
          // JSX last-wins makes the outermost, most-semantic owner survive
          // multi-level transparent chains.
          node.attributes.unshift(
            t.jsxAttribute(t.jsxIdentifier(OWNER_ATTR), t.stringLiteral(value)),
          );
        },
      },
    };
  };
}
