import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import { domReads } from "./dom-reads";

const createRule = lintRuleCreator(import.meta.url);

const COMPONENT = /^[A-Z]/;
const HOOK = /^use[A-Z0-9]/;

/** Hooks that call a function argument DURING render: name → argument indexes. */
const RENDER_CALLBACK_ARGS: Record<string, readonly number[]> = {
  useState: [0],
  useReducer: [2],
  useMemo: [0],
  // getServerSnapshot: what a static render calls. (getSnapshot runs live only.)
  useSyncExternalStore: [2],
  // Array iteration in the render body (`items.map(i => <b>{…}</b>)`).
  map: [0],
  flatMap: [0],
  filter: [0],
  reduce: [0],
  find: [0],
  findIndex: [0],
  some: [0],
  every: [0],
  forEach: [0],
};

/** Only `plugins/<…>/web/<…>` files — the ones a page renders. */
const WEB_FILE = /(?:^|\/)plugins\/.*\/web\//;

type Fn =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

function isFn(n: TSESTree.Node): n is Fn {
  return (
    n.type === "FunctionDeclaration" ||
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression"
  );
}

function calleeName(call: TSESTree.CallExpression): string | null {
  const c = call.callee;
  if (c.type === "Identifier") return c.name;
  if (c.type === "MemberExpression" && c.property.type === "Identifier")
    return c.property.name;
  return null;
}

/** The binding a function is declared as: its own id, or its declarator's (through one memo/forwardRef). */
function boundId(fn: Fn): TSESTree.Identifier | null {
  if (fn.type === "FunctionDeclaration") return fn.id;
  let p: TSESTree.Node | undefined = fn.parent;
  while (
    p?.type === "CallExpression" &&
    ["memo", "forwardRef"].includes(calleeName(p) ?? "")
  )
    p = p.parent;
  if (p?.type === "VariableDeclarator" && p.id.type === "Identifier")
    return p.id;
  return null;
}

function enclosingFn(n: TSESTree.Node): Fn | null {
  for (let p = n.parent; p; p = p.parent) if (isFn(p)) return p;
  return null;
}

/**
 * The component or hook whose render runs `fn`'s body, or null when `fn` does
 * not run while rendering (an effect, a handler, a module helper).
 */
function renderRoot(fn: Fn): Fn | null {
  const id = boundId(fn);
  if (id !== null && (COMPONENT.test(id.name) || HOOK.test(id.name))) return fn;
  const p = fn.parent;
  if (p?.type !== "CallExpression") return null;
  const enclosing = enclosingFn(fn);
  if (enclosing === null) return null;
  // An IIFE runs where it is written.
  if (p.callee === fn) return renderRoot(enclosing);
  const indexes = RENDER_CALLBACK_ARGS[calleeName(p) ?? ""];
  if (
    indexes === undefined ||
    !indexes.includes((p.arguments as readonly TSESTree.Node[]).indexOf(fn))
  )
    return null;
  return renderRoot(enclosing);
}

/**
 * `renderMode() === "static"` (and its `!==` / `"live"` spellings): which
 * branch runs live — "consequent" or "alternate" — or null when `test` is not
 * such a comparison.
 */
function liveBranchOf(
  test: TSESTree.Expression,
): "consequent" | "alternate" | null {
  if (test.type !== "BinaryExpression") return null;
  if (!["===", "!==", "==", "!="].includes(test.operator)) return null;
  const isModeCall = (e: TSESTree.Node): boolean =>
    e.type === "CallExpression" &&
    e.callee.type === "Identifier" &&
    e.callee.name === "renderMode" &&
    e.arguments.length === 0;
  const sides = [test.left, test.right];
  const call = sides.find(isModeCall);
  const literal = sides.find(
    (e): e is TSESTree.StringLiteral =>
      e.type === "Literal" && typeof e.value === "string",
  );
  if (call === undefined || literal === undefined) return null;
  const equal = test.operator === "===" || test.operator === "==";
  const isLive = (literal.value === "live") === equal;
  return isLive ? "consequent" : "alternate";
}

function exits(stmt: TSESTree.Statement): boolean {
  if (stmt.type === "ReturnStatement" || stmt.type === "ThrowStatement")
    return true;
  if (stmt.type === "BlockStatement") {
    const last = stmt.body.at(-1);
    return last !== undefined && exits(last);
  }
  return false;
}

/** Does `node` sit where only a live render reaches — past a `renderMode()` test? */
function isLiveGuarded(node: TSESTree.Node): boolean {
  let child: TSESTree.Node = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    if (
      (p.type === "ConditionalExpression" || p.type === "IfStatement") &&
      child !== p.test
    ) {
      const live = liveBranchOf(p.test);
      if (live !== null && p[live] === child) return true;
    }
    if (
      p.type === "LogicalExpression" &&
      p.operator === "&&" &&
      child === p.right &&
      liveBranchOf(p.left) === "consequent"
    )
      return true;
    if (p.type === "BlockStatement" || p.type === "Program") {
      const at = (p.body as TSESTree.Node[]).indexOf(child);
      for (const stmt of p.body.slice(0, Math.max(at, 0))) {
        // `if (renderMode() === "static") return …;` — the rest is live.
        if (
          stmt.type === "IfStatement" &&
          stmt.alternate === null &&
          liveBranchOf(stmt.test) === "alternate" &&
          exits(stmt.consequent)
        )
          return true;
      }
    }
  }
  return false;
}

function isExported(fn: Fn): boolean {
  for (let p = fn.parent; p; p = p.parent) {
    if (
      p.type === "ExportNamedDeclaration" ||
      p.type === "ExportDefaultDeclaration"
    )
      return true;
    if (p.type === "Program" || p.type === "BlockStatement") return false;
  }
  return false;
}

export default createRule({
  name: "no-render-time-dom",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading browser globals while a React component or hook " +
        "renders: a static render (no DOM) throws there, and the live app " +
        "reads a value that never updates.",
    },
    schema: [],
    messages: {
      renderTimeDom:
        "`{{name}}` is read while this component renders. A static render " +
        "(the website's HTML for robots, `dom/render-mode`) has no DOM and " +
        "throws here, and live it reads a value that never updates. Read it " +
        "through `useBrowserValue` / `useMediaQuery` / `useViewportSize` / " +
        "`useOwnedElement` (@plugins/primitives/plugins/dom/plugins/render-mode/web), " +
        "in an effect or event handler, or behind `renderMode()` in the " +
        "building block.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (!WEB_FILE.test(filename)) return {};
    const { sourceCode } = context;

    // A component no static render reaches: every use of it in this file sits
    // behind a `renderMode()` test (or inside another such component), and it
    // is not exported. `<MediaPlayer>` → static ? <Static/> : <Live/>.
    const liveOnlyMemo = new Map<Fn, boolean>();
    const isLiveOnly = (root: Fn): boolean => {
      const memo = liveOnlyMemo.get(root);
      if (memo !== undefined) return memo;
      liveOnlyMemo.set(root, false); // a cycle is not proof
      const id = boundId(root);
      let result = false;
      if (id !== null && !isExported(root)) {
        const variable = sourceCode
          .getDeclaredVariables(
            root.type === "FunctionDeclaration"
              ? root
              : (id.parent as TSESTree.VariableDeclarator),
          )
          .find((v) => v.name === id.name);
        const refs = (variable?.references ?? []).filter(
          (r: TSESLint.Scope.Reference) => r.identifier !== id && !r.init,
        );
        result =
          refs.length > 0 &&
          refs.every((r: TSESLint.Scope.Reference) => {
            const ident = r.identifier as TSESTree.Node;
            if (isLiveGuarded(ident)) return true;
            const fn = enclosingFn(ident);
            const outer = fn === null ? null : renderRoot(fn);
            return outer !== null && isLiveOnly(outer);
          });
      }
      liveOnlyMemo.set(root, result);
      return result;
    };

    return {
      "Program:exit"(): void {
        for (const { identifier, name } of domReads(sourceCode)) {
          const fn = enclosingFn(identifier);
          const root = fn === null ? null : renderRoot(fn);
          if (root === null) continue;
          if (isLiveGuarded(identifier) || isLiveOnly(root)) continue;
          context.report({
            node: identifier,
            messageId: "renderTimeDom",
            data: { name },
          });
        }
      },
    };
  },
});
