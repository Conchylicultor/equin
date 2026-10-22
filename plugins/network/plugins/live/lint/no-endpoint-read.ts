import {
  ASTUtils,
  ESLintUtils,
  type ParserServicesWithTypeInformation,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";
import type { Type as TsType, TypeChecker } from "typescript";
import type { LintRuleDocs } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = ESLintUtils.RuleCreator<LintRuleDocs>(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * no-endpoint-read
 *
 * A server read in the browser is a live resource: a `liveValue` (by `params`,
 * by a typed `query`, or key-range-`paged`) or a `liveCollection`, read with
 * `useLive`. The request/response path beside it — `useEndpoint`,
 * `useEndpointResource`, a TanStack `useQuery` family hook, a `queryFn` that
 * calls `fetchEndpoint`, or a GET `fetchEndpoint` / NDJSON stream an effect
 * runs — is a second read path with no push, so its value goes stale or gets
 * polled (research/2026-10-09-global-live-structured-paged-values.md,
 * research/2026-10-11-global-endpoint-reads-onto-live.md P0.2).
 *
 * Flags, in files under a `web/` folder:
 * - every import of a read hook from the barrel that exports it — a named
 *   import (aliases included), an `export { … } from` re-export — and every
 *   read of one off that barrel's module object (a namespace import or an
 *   awaited dynamic import, by member or by destructuring), resolved as
 *   `no-legacy-resource-spelling` does;
 * - a `fetchEndpoint(...)` call (the transport-bound client, recognised by the
 *   name of its binding — `const fetchEndpoint = useFetchEndpoint()`, a
 *   `fetchEndpoint` parameter; `endpoints/fetch-endpoint-binding-name` keeps
 *   every binding so named) lexically inside a `queryFn` property's value;
 * - a `fetchEndpoint(def, …)` of a GET endpoint, or a `readNdjson(transport, route, …)`
 *   over a GET route, that runs as a READ (see "Read context" below);
 * - `invalidateQueries` / `refetchQueries` whose argument names an endpoint
 *   read's query key — `endpointQueryKey(...)`, or the raw
 *   `["endpoint", …]` key it spells — directly or through a `const`. Refreshing
 *   an endpoint read by hand is what a pushed read makes unnecessary.
 *
 * ## GET-ness
 *
 * Decided by the type checker, not by name: the `route` of an `EndpointDef` is
 * its literal route type (`"GET /api/…"`, the `Route` parameter
 * `defineEndpoint` infers), and `readNdjson`'s second argument (after the transport) is the
 * `.route` of one. A route whose type is not a string literal (a generic
 * wrapper's `EndpointDef<Route, …>`, a widened `string`) cannot be told apart
 * from a GET, so it counts as one: the rule fails toward flagging, and the
 * site is either sanctioned substrate or debt.
 *
 * ## Read context
 *
 * Where a call runs is decided by the innermost enclosing function that says
 * so, walking outwards (callbacks that say nothing — `.then(cb)`,
 * `Promise.all`, an IIFE, `setTimeout` — are transparent):
 * - an `on*` prop / property value (a JSX handler, `onSuccess`), a
 *   `mutationFn`, or a callback handed to an event registrar
 *   (`addEventListener`, `subscribe`, `register…`, `on`) is an ACTION — not
 *   flagged, even when an effect does the registering;
 * - the callback of `useEffect` / `useLayoutEffect` / `useInsertionEffect`,
 *   or of `useMemo` / `useState` (it runs during render), is a READ;
 * - a function named like a hook (`use…`) or a component (`Capitalised`) is a
 *   READ: its body runs on render;
 * - any other NAMED function (a declaration, a `const f = …`, a
 *   `const f = useCallback(…)` or any other callback hook) is classified by
 *   its uses in the file: a READ if any call or callback use of it is
 *   (`useEffect(() => { void load(); })`, a module helper an effect calls), an
 *   ACTION if used only as one;
 * - a function that escapes the file's view — stored in an object or a class,
 *   passed as a non-`on*` prop, returned, exported, handed to another hook —
 *   is unflagged: the rule sees one file, so a GET wrapper another file's
 *   effect calls is that file's blind spot;
 * - module top level (no enclosing function) is a READ: it runs on import.
 *
 * An imperative `fetchEndpoint` — a mutation, an event handler — is not a
 * read and is not flagged. Test code is out of scope (a contributed rule's
 * default). The substrate that defines or wraps these hooks is exempt through
 * sanctioned entries in its plugins' `exempt/index.ts`; the remaining sites
 * are debt entries in theirs.
 */

const ENDPOINTS_WEB = "@plugins/infra/plugins/endpoints/web";
const NDJSON_WEB = "@plugins/infra/plugins/ndjson-stream/web";

/** Each barrel → the read hooks it exports. */
const READ_HOOKS: Readonly<Record<string, readonly string[]>> = {
  [ENDPOINTS_WEB]: ["useEndpoint"],
  "@plugins/primitives/plugins/live-state/web": ["useEndpointResource"],
  "@tanstack/react-query": [
    "useQuery",
    "useInfiniteQuery",
    "useSuspenseQuery",
    "useSuspenseInfiniteQuery",
    "useQueries",
    "useSuspenseQueries",
  ],
};

const FETCH_ENDPOINT = "fetchEndpoint";
const READ_NDJSON = "readNdjson";
const ENDPOINT_QUERY_KEY = "endpointQueryKey";

/**
 * Each barrel → the plain functions the rule follows calls of. The endpoint
 * client is not one: no barrel exports a fetcher, it is a value bound per
 * transport and recognised by its binding name (`boundFunction`).
 */
const TRACKED_FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
  [ENDPOINTS_WEB]: [ENDPOINT_QUERY_KEY],
  [NDJSON_WEB]: [READ_NDJSON],
};

/** The QueryClient methods that refresh a query by key. */
const REFRESH_METHODS = new Set(["invalidateQueries", "refetchQueries"]);

/** The raw first element of every endpoint read's query key. */
const ENDPOINT_KEY_HEAD = "endpoint";

/** Hooks whose first-argument callback runs after commit. */
const EFFECT_HOOKS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
]);
/** Hooks whose first-argument callback runs during render. */
const RENDER_HOOKS = new Set(["useMemo", "useState"]);
/**
 * A call that registers its callback for an event — the callback runs on the
 * event, like a handler, even when the registering is done by an effect.
 */
const EVENT_REGISTRAR =
  /^(addEventListener|addListener|on|once|subscribe|listen|register[A-Z]\w*)$/;
/** A prop / property naming a handler. */
const HANDLER_NAME = /^on[A-Z]/;
/** An assigned event-handler property: DOM's `onclick` / `onmessage`, or `onChange`. */
const EVENT_PROPERTY = /^on[a-zA-Z]/;
/** A property holding a mutation's write. */
const MUTATION_KEYS = new Set(["mutationFn"]);
const HOOK_NAME = /^use[A-Z0-9]/;
const COMPONENT_NAME = /^[A-Z]/;

/** Whether the file sits under a `web/` folder (the browser runtime). */
function isWebFile(filename: string): boolean {
  return /(^|[\\/])web[\\/]/.test(filename);
}

function isReadHook(source: string, name: string): boolean {
  return READ_HOOKS[source]?.includes(name) ?? false;
}

function isTrackedFunction(source: string, name: string): boolean {
  return TRACKED_FUNCTIONS[source]?.includes(name) ?? false;
}

/** Whether `source` is a barrel whose module object the rule follows. */
function isWatchedBarrel(source: string): boolean {
  return (
    READ_HOOKS[source] !== undefined || TRACKED_FUNCTIONS[source] !== undefined
  );
}

function propertyName(node: TSESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  return null;
}

/** A member access's static name (`a.b`, `a["b"]`), or null. */
function memberName(node: TSESTree.MemberExpression): string | null {
  return node.computed && node.property.type !== "Literal"
    ? null
    : propertyName(node.property);
}

/** The watched barrel `import("<barrel>")` loads, or null. */
function dynamicImportBarrel(node: TSESTree.Node): string | null {
  if (node.type !== "ImportExpression") return null;
  const source = node.source;
  if (source.type !== "Literal" || typeof source.value !== "string")
    return null;
  return isWatchedBarrel(source.value) ? source.value : null;
}

/** The watched barrel an `await import("<barrel>")` evaluates to, or null. */
function awaitedImportBarrel(node: TSESTree.Node | null): string | null {
  if (node?.type !== "AwaitExpression") return null;
  return dynamicImportBarrel(node.argument);
}

/** Whether `node` sits inside the value of a `queryFn` property. */
function insideQueryFn(node: TSESTree.Node): boolean {
  for (let child = node; child.type !== "Program"; child = child.parent) {
    const parent = child.parent;
    if (
      parent.type === "Property" &&
      parent.value === child &&
      !parent.computed &&
      propertyName(parent.key) === "queryFn"
    )
      return true;
  }
  return false;
}

/** The called name of `f(…)` / `React.f(…)`, or null. */
function calleeName(callee: TSESTree.Node): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") return memberName(callee);
  return null;
}

function isNode(value: unknown): value is TSESTree.Node {
  return typeof value === "object" && value !== null && "type" in value;
}

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression;

function isFunction(node: TSESTree.Node): node is FunctionNode {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  );
}

/** Whether a value is passed as an `on*` handler or a `mutationFn`. */
function actionSlot(value: TSESTree.Node): boolean {
  const parent = value.parent;
  if (parent === undefined) return false;
  if (
    parent.type === "JSXExpressionContainer" &&
    parent.parent.type === "JSXAttribute"
  ) {
    const name = parent.parent.name;
    return name.type === "JSXIdentifier" && HANDLER_NAME.test(name.name);
  }
  if (
    parent.type === "Property" &&
    parent.value === value &&
    !parent.computed
  ) {
    const key = propertyName(parent.key);
    return key !== null && (HANDLER_NAME.test(key) || MUTATION_KEYS.has(key));
  }
  return false;
}

/** Whether `value` is the first argument of a call to one of `hooks`. */
function firstArgumentOf(
  value: TSESTree.Node,
  hooks: ReadonlySet<string>,
): boolean {
  const parent = value.parent;
  if (parent?.type !== "CallExpression" || parent.arguments[0] !== value)
    return false;
  const name = calleeName(parent.callee);
  return name !== null && hooks.has(name);
}

/**
 * How code runs: as a `read` (render, an effect, module load), as an `action`
 * (a handler, a mutation), or `unknown` (it only escapes the file's view).
 */
type Run = "read" | "action" | "unknown";

/**
 * The literal routes a route type spells, or null when any part of it is not
 * a string literal (a type parameter is read through its constraint).
 */
function literalRoutes(checker: TypeChecker, type: TsType): string[] | null {
  const constrained = checker.getBaseConstraintOfType(type) ?? type;
  const parts = constrained.isUnion() ? constrained.types : [constrained];
  const routes: string[] = [];
  for (const part of parts) {
    if (!part.isStringLiteral()) return null;
    routes.push(part.value);
  }
  return routes;
}

/** Whether a route type may be a GET — true when it is not a known literal. */
function mayBeGet(checker: TypeChecker, type: TsType): boolean {
  const routes = literalRoutes(checker, type);
  return routes === null || routes.some((r) => r.split(" ", 1)[0] === "GET");
}

export default createRule({
  name: "no-endpoint-read",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow request/response server reads in the browser — declare a liveValue (params / query / paged) or a liveCollection and read it with useLive.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      readHook:
        "`{{name}}` reads the server over request/response, with no push. " +
        "Declare the read as a `liveValue` (`params`, a typed `query`, or " +
        "key-range-`paged`) or a `liveCollection`, and read it with `useLive` " +
        "from @plugins/network/plugins/live — see " +
        "plugins/network/plugins/live/CLAUDE.md. Endpoints stay for writes " +
        "(fetchEndpoint in a mutation or a handler).",
      queryFnFetch:
        "`fetchEndpoint` inside a `queryFn` is a request/response server read, " +
        "with no push. Declare the read as a `liveValue` (`params`, a typed " +
        "`query`, or key-range-`paged`) or a `liveCollection`, and read it with " +
        "`useLive` from @plugins/network/plugins/live — see " +
        "plugins/network/plugins/live/CLAUDE.md. Endpoints stay for writes " +
        "(fetchEndpoint in a mutation or a handler).",
      effectFetch:
        "`{{name}}` of a GET endpoint here runs as a read (render, an effect, " +
        "a hook, or a function they call) — a request/response server read " +
        "with no push, so it goes stale or gets polled. Declare it as a " +
        "`liveValue` (`params`, a typed `query`, or cursor-`paged`) or a " +
        "`liveCollection`, and read it with `useLive` from " +
        "@plugins/network/plugins/live — see " +
        "plugins/network/plugins/live/CLAUDE.md. A GET an event handler " +
        "(`on*`) or a `mutationFn` runs is not flagged.",
      refreshEndpointKey:
        "`{{name}}` over an endpoint read's query key refreshes a " +
        "request/response read by hand. A live read is pushed when its " +
        "source changes: declare it as a `liveValue` / `liveCollection` read " +
        "with `useLive` (plugins/network/plugins/live/CLAUDE.md), and drop the " +
        "manual refresh.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!isWebFile(context.filename)) return {};

    const reportHook = (node: TSESTree.Node, name: string) => {
      context.report({ node, messageId: "readHook", data: { name } });
    };

    /**
     * The local names that MAY hold a watched barrel's module object — a cheap
     * pre-filter, so scope is resolved only for a read off one of them.
     */
    const moduleLocals = new Set<string>();
    /** The local names that MAY be a tracked function (imported or destructured). */
    const functionLocals = new Set<string>();

    /** Type information, built on the first call that needs it. */
    let services: ParserServicesWithTypeInformation | undefined;
    const typeServices = (): ParserServicesWithTypeInformation =>
      (services ??= ESLintUtils.getParserServices(context));

    const definitionOf = (local: TSESTree.Identifier) => {
      const scope: TSESLint.Scope.Scope = context.sourceCode.getScope(local);
      return ASTUtils.findVariable(scope, local)?.defs[0];
    };

    /** The watched barrel `local` holds the module object of, or null. */
    const boundBarrel = (local: TSESTree.Identifier): string | null => {
      if (!moduleLocals.has(local.name)) return null;
      const def = definitionOf(local);
      if (def === undefined) return null;
      const node: TSESTree.Node = def.node;
      if (node.type === "ImportNamespaceSpecifier") {
        const source = node.parent.source.value;
        return isWatchedBarrel(source) ? source : null;
      }
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier")
        return awaitedImportBarrel(node.init);
      return null;
    };

    /** The watched barrel an expression evaluates to the module object of. */
    const moduleBarrel = (node: TSESTree.Node): string | null =>
      node.type === "Identifier"
        ? boundBarrel(node)
        : awaitedImportBarrel(node);

    /** The tracked function `local` is bound to, or null. */
    const boundFunction = (local: TSESTree.Identifier): string | null => {
      if (!functionLocals.has(local.name)) return null;
      const def = definitionOf(local);
      if (def === undefined) return null;
      const node: TSESTree.Node = def.node;
      // The transport-bound endpoint client is a VALUE — `const fetchEndpoint
      // = useFetchEndpoint()`, a `fetchEndpoint: FetchEndpoint` parameter, a
      // destructured `{ fetchEndpoint }` — and every binding of it carries
      // that name (`endpoints/fetch-endpoint-binding-name`), so any local
      // binding of the name is the client.
      if (
        local.name === FETCH_ENDPOINT &&
        node.type !== "ImportSpecifier" &&
        def.type !== "FunctionName" &&
        def.type !== "ClassName"
      )
        return FETCH_ENDPOINT;
      if (node.type === "ImportSpecifier") {
        if (node.parent.type !== "ImportDeclaration") return null;
        const imported = propertyName(node.imported);
        return imported !== null &&
          isTrackedFunction(node.parent.source.value, imported)
          ? imported
          : null;
      }
      // `const { fetchEndpoint: f } = m` — the destructured module object.
      if (
        node.type === "VariableDeclarator" &&
        node.init !== null &&
        node.id.type === "ObjectPattern"
      ) {
        const source = moduleBarrel(node.init);
        if (source === null) return null;
        for (const prop of node.id.properties) {
          if (
            prop.type === "Property" &&
            prop.value.type === "Identifier" &&
            prop.value.name === local.name
          ) {
            const key =
              prop.computed && prop.key.type !== "Literal"
                ? null
                : propertyName(prop.key);
            return key !== null && isTrackedFunction(source, key) ? key : null;
          }
        }
      }
      return null;
    };

    /** The tracked function a callee names, or null. */
    const calledFunction = (callee: TSESTree.Node): string | null => {
      if (callee.type === "Identifier") return boundFunction(callee);
      if (callee.type !== "MemberExpression") return null;
      const member = memberName(callee);
      if (member === null) return null;
      const source = moduleBarrel(callee.object);
      return source !== null && isTrackedFunction(source, member)
        ? member
        : null;
    };

    // ── Read context ────────────────────────────────────────────────────

    /**
     * How the code at `node` runs: walk out to the innermost function that
     * says so (see the rule doc); module top level runs on import.
     * `seen` breaks recursion through mutually-calling named functions.
     */
    const runOf = (node: TSESTree.Node, seen: Set<unknown>): Run => {
      for (let cur = node; cur.type !== "Program"; cur = cur.parent) {
        if (cur === node || !isFunction(cur)) continue;
        const run = runOfFunction(cur, seen);
        if (run !== null) return run;
      }
      return "read";
    };

    /** How a function's body runs, or null when it says nothing (transparent). */
    const runOfFunction = (
      fn: FunctionNode,
      seen: Set<unknown>,
    ): Run | null => {
      if (actionSlot(fn)) return "action";
      const parent = fn.parent;
      if (parent.type === "CallExpression" && parent.callee !== fn) {
        const callee = calleeName(parent.callee);
        if (callee === null) return null;
        if (
          firstArgumentOf(fn, EFFECT_HOOKS) ||
          firstArgumentOf(fn, RENDER_HOOKS)
        )
          return "read";
        if (EVENT_REGISTRAR.test(callee)) return "action";
        if (HOOK_NAME.test(callee)) {
          // A callback hook (`useCallback`, `useEventCallback`, …): the
          // callback runs wherever the hook's result is used.
          const holder = parent.parent;
          return holder.type === "VariableDeclarator" &&
            holder.init === parent &&
            holder.id.type === "Identifier"
            ? runOfUses(holder, holder.id.name, seen)
            : "unknown";
        }
        return null;
      }
      // Stored in an object / class, or handed to a component as a prop: it
      // runs wherever the holder calls it, which this file does not show.
      if (
        parent.type === "Property" ||
        parent.type === "MethodDefinition" ||
        parent.type === "PropertyDefinition" ||
        (parent.type === "JSXExpressionContainer" &&
          parent.parent.type === "JSXAttribute")
      )
        return "unknown";
      const escaped = escapeRun(fn);
      if (escaped !== null) return escaped;
      // `export default () => …` / `export default function () {…}`: called
      // by whoever imports it.
      if (
        parent.type === "ExportDefaultDeclaration" &&
        (fn.type === "ArrowFunctionExpression" || fn.id === null)
      )
        return "unknown";
      let declaration: TSESTree.Node | null = null;
      let name: string | undefined;
      if (
        parent.type === "VariableDeclarator" &&
        parent.init === fn &&
        parent.id.type === "Identifier"
      ) {
        declaration = parent;
        name = parent.id.name;
      } else if (fn.type !== "ArrowFunctionExpression" && fn.id !== null) {
        if (fn.type === "FunctionDeclaration") declaration = fn;
        name = fn.id.name;
      }
      if (name === undefined) return null;
      if (HOOK_NAME.test(name) || COMPONENT_NAME.test(name)) return "read";
      return declaration === null ? null : runOfUses(declaration, name, seen);
    };

    /** How a named function runs, from every use of its binding in the file. */
    const runOfUses = (
      declaration: TSESTree.Node,
      name: string,
      seen: Set<unknown>,
    ): Run => {
      const variable = context.sourceCode
        .getDeclaredVariables(declaration)
        .find((v) => v.name === name);
      if (variable === undefined || seen.has(variable)) return "unknown";
      seen.add(variable);
      let run: Run = "unknown";
      for (const ref of variable.references) {
        if (ref.init === true) continue;
        const use = runOfReference(ref.identifier, seen);
        if (use === "read") return "read";
        if (use === "action") run = "action";
      }
      return run;
    };

    /** How one use of a named function runs it. */
    const runOfReference = (
      id: TSESTree.Identifier | TSESTree.JSXIdentifier,
      seen: Set<unknown>,
    ): Run => {
      const parent = id.parent;
      if (parent.type === "CallExpression") {
        if (parent.callee === id) return runOf(parent, seen);
        // Passed as a callback: an effect / render hook runs it; an event
        // registrar runs it on the event; another hook hides what it does
        // with it; any other call (`.then(f)`, `setTimeout(f)`) runs it where
        // the call sits.
        const callee = calleeName(parent.callee);
        if (
          firstArgumentOf(id, EFFECT_HOOKS) ||
          firstArgumentOf(id, RENDER_HOOKS)
        )
          return "read";
        if (callee !== null && EVENT_REGISTRAR.test(callee)) return "action";
        if (callee !== null && HOOK_NAME.test(callee)) return "unknown";
        return runOf(parent, seen);
      }
      if (actionSlot(id)) return "action";
      return escapeRun(id) ?? "unknown";
    };

    /**
     * How a function (or a named reference to one) runs when it LEAVES the
     * code that defines it rather than being called there, or null when it
     * does not leave: returned (`return () => …`, an arrow's concise body —
     * its caller runs it, which this file does not show), or assigned
     * (`el.onclick = f` / `es.onmessage = f` is an event handler; any other
     * target, such as the latest-ref `ref.current = f`, is called wherever
     * the holder is read).
     */
    const escapeRun = (node: TSESTree.Node): Run | null => {
      const parent = node.parent;
      if (parent === undefined) return null;
      if (parent.type === "ReturnStatement") return "unknown";
      if (parent.type === "ArrowFunctionExpression" && parent.body === node)
        return "unknown";
      if (parent.type === "AssignmentExpression" && parent.right === node) {
        const target = parent.left;
        if (target.type === "MemberExpression") {
          const prop = memberName(target);
          if (prop !== null && EVENT_PROPERTY.test(prop)) return "action";
        }
        return "unknown";
      }
      return null;
    };

    // ── GET-ness ────────────────────────────────────────────────────────

    /** Whether a `fetchEndpoint(def, …)` call's endpoint may be a GET. */
    const fetchMayBeGet = (call: TSESTree.CallExpression): boolean => {
      const def = call.arguments[0];
      if (def === undefined || def.type === "SpreadElement") return true;
      const { program, esTreeNodeToTSNodeMap } = typeServices();
      const checker = program.getTypeChecker();
      const tsNode = esTreeNodeToTSNodeMap.get(def);
      const route = checker.getTypeAtLocation(tsNode).getProperty("route");
      if (route === undefined) return true;
      return mayBeGet(
        checker,
        checker.getTypeOfSymbolAtLocation(route, tsNode),
      );
    };

    /** Whether a `readNdjson(transport, route, …)` call's route may be a GET. */
    const streamMayBeGet = (call: TSESTree.CallExpression): boolean => {
      const route = call.arguments[1];
      if (route === undefined || route.type === "SpreadElement") return true;
      const { program, esTreeNodeToTSNodeMap } = typeServices();
      const checker = program.getTypeChecker();
      return mayBeGet(
        checker,
        checker.getTypeAtLocation(esTreeNodeToTSNodeMap.get(route)),
      );
    };

    // ── Endpoint query keys ─────────────────────────────────────────────

    /** Whether an expression is (or a `const` holds) an endpoint query key. */
    const isEndpointKey = (node: TSESTree.Node, depth = 0): boolean => {
      if (depth > 4) return false;
      if (node.type === "CallExpression")
        return calledFunction(node.callee) === ENDPOINT_QUERY_KEY;
      if (node.type === "ArrayExpression") {
        const head = node.elements[0];
        return head?.type === "Literal" && head.value === ENDPOINT_KEY_HEAD;
      }
      if (node.type === "Identifier") {
        const def = definitionOf(node);
        return (
          def?.node.type === "VariableDeclarator" &&
          def.node.id.type === "Identifier" &&
          def.node.init !== null &&
          isEndpointKey(def.node.init, depth + 1)
        );
      }
      return false;
    };

    /**
     * Whether any expression inside `node` is an endpoint query key — not
     * looking into nested functions, whose bodies are not the argument.
     */
    const containsEndpointKey = (node: TSESTree.Node): boolean => {
      if (isEndpointKey(node)) return true;
      for (const key of context.sourceCode.visitorKeys[node.type] ?? []) {
        const value: unknown = (node as unknown as Record<string, unknown>)[
          key
        ];
        for (const child of Array.isArray(value) ? value : [value]) {
          if (!isNode(child) || isFunction(child)) continue;
          if (containsEndpointKey(child)) return true;
        }
      }
      return false;
    };

    return {
      Program(node) {
        // The endpoint client is recognised by its binding name wherever it
        // is bound (see `boundFunction`).
        functionLocals.add(FETCH_ENDPOINT);
        // Imports are always top-level, so every namespace / tracked-function
        // local is known before any read of it is visited.
        for (const stmt of node.body) {
          if (stmt.type !== "ImportDeclaration") continue;
          for (const spec of stmt.specifiers) {
            if (spec.type === "ImportNamespaceSpecifier")
              moduleLocals.add(spec.local.name);
            else if (spec.type === "ImportSpecifier") {
              const imported = propertyName(spec.imported);
              if (
                imported !== null &&
                isTrackedFunction(stmt.source.value, imported)
              )
                functionLocals.add(spec.local.name);
            }
          }
        }
      },

      ImportDeclaration(node) {
        const source = node.source.value;
        if (!isWatchedBarrel(source)) return;
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier") continue;
          const imported = propertyName(spec.imported);
          if (imported !== null && isReadHook(source, imported))
            reportHook(spec, imported);
        }
      },

      ExportNamedDeclaration(node) {
        if (node.source === null) return;
        const source = node.source.value;
        for (const spec of node.specifiers) {
          // `local` is the name on the source side of `export { local as x }`.
          const exported = propertyName(spec.local);
          if (exported !== null && isReadHook(source, exported))
            reportHook(spec, exported);
        }
      },

      VariableDeclarator(node) {
        if (node.init === null) return;
        // `const m = await import("<barrel>")` — `m` is a module object.
        if (node.id.type === "Identifier") {
          if (awaitedImportBarrel(node.init) !== null)
            moduleLocals.add(node.id.name);
          return;
        }
        // `const { useQuery } = m` / `= await import("<barrel>")`.
        if (node.id.type !== "ObjectPattern") return;
        const source = moduleBarrel(node.init);
        if (source === null) return;
        for (const prop of node.id.properties) {
          if (prop.type !== "Property") continue;
          const key =
            prop.computed && prop.key.type !== "Literal"
              ? null
              : propertyName(prop.key);
          if (key === null) continue;
          if (isReadHook(source, key)) reportHook(prop, key);
          else if (
            isTrackedFunction(source, key) &&
            prop.value.type === "Identifier"
          )
            functionLocals.add(prop.value.name);
        }
      },

      MemberExpression(node) {
        const source = moduleBarrel(node.object);
        if (source === null) return;
        const member = memberName(node);
        if (member !== null && isReadHook(source, member))
          reportHook(node, member);
      },

      CallExpression(node) {
        const fn = calledFunction(node.callee);
        if (fn === FETCH_ENDPOINT) {
          if (insideQueryFn(node))
            context.report({ node, messageId: "queryFnFetch" });
          else if (runOf(node, new Set()) === "read" && fetchMayBeGet(node))
            context.report({
              node,
              messageId: "effectFetch",
              data: { name: FETCH_ENDPOINT },
            });
          return;
        }
        if (fn === READ_NDJSON) {
          if (runOf(node, new Set()) === "read" && streamMayBeGet(node))
            context.report({
              node,
              messageId: "effectFetch",
              data: { name: READ_NDJSON },
            });
          return;
        }
        if (
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.property.type === "Identifier" &&
          REFRESH_METHODS.has(node.callee.property.name) &&
          node.arguments.some(containsEndpointKey)
        )
          context.report({
            node,
            messageId: "refreshEndpointKey",
            data: { name: node.callee.property.name },
          });
      },
    };
  },
});
