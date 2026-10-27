import {
  ASTUtils,
  ESLintUtils,
  type ParserServicesWithTypeInformation,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";
import type { LintRuleDocs } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = ESLintUtils.RuleCreator<LintRuleDocs>(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * no-endpoint-read
 *
 * A server read in the browser is a live resource: a `liveValue` (by `params`,
 * by a typed `query`, key-range-`paged`, or `bytes`) or a `liveCollection`,
 * read with `useLive` — or, for a question an event asks and its own `await`
 * consumes, with `useLiveReader`. Endpoints are for writes
 * (research/2026-10-26-global-browser-reads-only-through-live.md).
 *
 * What tsc already holds is not repeated here: a GET def handed to
 * `fetchEndpoint` / `useEndpointMutation` / `readNdjson` does not compile
 * (endpoints' derived `read` marker, `& WriteEndpoint`), so this rule no
 * longer reads a route's method. It flags, in files under a `web/` folder:
 *
 * - **The TanStack read hooks** — every import of `useQuery` and its family
 *   from `@tanstack/react-query` (a named import, aliases included, an
 *   `export { … } from` re-export) and every read of one off the barrel's
 *   module object (a namespace import or an awaited dynamic import, by member
 *   or by destructuring), resolved as `no-legacy-resource-spelling` does;
 *   and a `fetchEndpoint(...)` lexically inside a `queryFn` property's value.
 * - **A write's answer used as a read** — a `fetchEndpoint(...)` (the
 *   transport-bound client, recognised by its binding name:
 *   `endpoints/fetch-endpoint-binding-name` keeps every binding so named) or
 *   a `mutateAsync(...)` (a mutation's, by member, or a local bound from it —
 *   destructured under any alias, or assigned from the member) of
 *   ANY method that runs in READ CONTEXT (below) and whose ANSWER IS USED. A
 *   write an effect fires and forgets — `void fetchEndpoint(save, …)`, an
 *   awaited statement, a `.then(() => …)` that ignores the answer — passes:
 *   effects run genuine writes (record a play, flush logs). What does not is
 *   a POST whose answer render, a hook or an effect consumes: that is a read
 *   wearing a write's method (chord's old `findLoops`).
 * - **A `LiveReader` call in read context** — the function `useLiveReader()`
 *   returns (recognised by its type, `LiveReader`) is for an event's own
 *   `await`; in render, a hook body or an effect the read is `useLive`.
 *
 * ## Answer used
 *
 * Followed outwards from the call: discarded by an expression statement,
 * `void`, a non-last sequence operand, or a `.then(cb)` whose callback takes
 * no parameter. Passed through by `await`, a type assertion, `?.`, a
 * conditional's branch, a logical's right side, `.catch` / `.finally`,
 * `Promise.all` / `allSettled` / `race` / `any`, and a function returning it —
 * whose answer is then followed at its call sites in the file (an IIFE, a
 * `.then` / `.map` callback, a named function or callback hook); a function
 * an effect hook runs, or one only an unknown callee runs, discards it.
 * Anything else (a binding, an argument, a condition, a property read) uses
 * it.
 *
 * ## Read context
 *
 * Where a call runs is decided by the innermost enclosing function that says
 * so, walking outwards (callbacks that say nothing — `.then(cb)`,
 * `Promise.all`, an IIFE, `setTimeout` — are transparent):
 * - an `on*` prop / property value (a JSX handler, `onSuccess`), a
 *   `mutationFn`, or a callback handed to an event registrar
 *   (`addEventListener`, `subscribe…`, `register…`, `on`) is an ACTION — not
 *   flagged, even when an effect or module load does the registering;
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
 *   is unflagged: the rule sees one file, so a wrapper another file's effect
 *   calls is that file's blind spot;
 * - module top level (no enclosing function) is a READ: it runs on import.
 *
 * ## Residual — held by review
 *
 * A POST read issued from an EVENT HANDLER is not flagged: nothing static
 * tells "click → POST read → show" from "click → POST write → show its
 * result". The honest spelling is as short as the lie — `useLiveReader` over
 * a `liveValue` — and the `ReadMarker` sentence a GET write fails with points
 * at it.
 *
 * Test code is out of scope (a contributed rule's default). The rule is
 * `noDebt`: its only exemptions are the two sanctioned substrate entries
 * (`network/live` and `primitives/live-state`, whose `web/` implements every
 * live read over TanStack queries) — never a debt entry.
 */

const REACT_QUERY = "@tanstack/react-query";

/** Each barrel → the read hooks it exports. */
const READ_HOOKS: Readonly<Record<string, readonly string[]>> = {
  [REACT_QUERY]: [
    "useQuery",
    "useInfiniteQuery",
    "useSuspenseQuery",
    "useSuspenseInfiniteQuery",
    "useQueries",
    "useSuspenseQueries",
  ],
};

/** The transport-bound endpoint client's binding name. */
const FETCH_ENDPOINT = "fetchEndpoint";
/** A mutation's promise-returning trigger, whose answer is the write's response. */
const MUTATE_ASYNC = "mutateAsync";
/** The type of the function `useLiveReader()` returns. */
const LIVE_READER = "LiveReader";

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
 * event, like a handler, even when the registering is done by an effect (or
 * by module load: `subscribeWsStatus((ev) => …)` at top level).
 */
const EVENT_REGISTRAR =
  /^(addEventListener|addListener|on|once|subscribe|subscribe[A-Z]\w*|listen|register[A-Z]\w*)$/;
/** A prop / property naming a handler. */
const HANDLER_NAME = /^on[A-Z]/;
/** An assigned event-handler property: DOM's `onclick` / `onmessage`, or `onChange`. */
const EVENT_PROPERTY = /^on[a-zA-Z]/;
/** A property holding a mutation's write. */
const MUTATION_KEYS = new Set(["mutationFn"]);
const HOOK_NAME = /^use[A-Z0-9]/;
const COMPONENT_NAME = /^[A-Z]/;
/** Promise combinators: their answer holds each element's answer. */
const PROMISE_COMBINATORS = new Set(["all", "allSettled", "race", "any"]);
/** Array methods whose result holds each callback's return. */
const MAPPING_METHODS = new Set(["map", "flatMap"]);

/** Whether the file sits under a `web/` folder (the browser runtime). */
function isWebFile(filename: string): boolean {
  return /(^|[\\/])web[\\/]/.test(filename);
}

function isReadHook(source: string, name: string): boolean {
  return READ_HOOKS[source]?.includes(name) ?? false;
}

/** Whether `source` is a barrel whose module object the rule follows. */
function isWatchedBarrel(source: string): boolean {
  return READ_HOOKS[source] !== undefined;
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

/** `X.<method>(…)` — the call whose callee is `member`, when `method` names it. */
function methodCall(
  member: TSESTree.MemberExpression,
): { method: string; call: TSESTree.CallExpression } | null {
  const call = member.parent;
  const method = memberName(member);
  if (
    method === null ||
    call.type !== "CallExpression" ||
    call.callee !== member
  )
    return null;
  return { method, call };
}

/** Whether `node` is `Promise.<combinator>`. */
function isPromiseCombinator(node: TSESTree.Node): boolean {
  if (node.type !== "MemberExpression") return false;
  const name = memberName(node);
  return (
    node.object.type === "Identifier" &&
    node.object.name === "Promise" &&
    name !== null &&
    PROMISE_COMBINATORS.has(name)
  );
}

/**
 * How code runs: as a `read` (render, an effect, module load), as an `action`
 * (a handler, a mutation), or `unknown` (it only escapes the file's view).
 */
type Run = "read" | "action" | "unknown";

export default createRule({
  name: "no-endpoint-read",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow request/response server reads in the browser — declare a liveValue or a liveCollection and read it with useLive (useLiveReader in an event handler).",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      readHook:
        "`{{name}}` reads the server over request/response, with no push. " +
        "Declare the read as a `liveValue` (`params`, a typed `query`, " +
        "key-range-`paged`, or `bytes`) or a `liveCollection`, and read it " +
        "with `useLive` from @plugins/network/plugins/live — see " +
        "plugins/network/plugins/live/CLAUDE.md. Endpoints stay for writes.",
      queryFnFetch:
        "`fetchEndpoint` inside a `queryFn` is a request/response server read, " +
        "with no push. Declare the read as a `liveValue` or a " +
        "`liveCollection`, and read it with `useLive` from " +
        "@plugins/network/plugins/live — see " +
        "plugins/network/plugins/live/CLAUDE.md. Endpoints stay for writes.",
      answerRead:
        "`{{name}}`'s answer is used where it runs as a read (render, a hook " +
        "body, an effect, module load, or a function they call) — a " +
        "request/response read wearing a write's method, with no push. " +
        "Declare the question as a `liveValue` (a typed `query` for a " +
        "structured one) and read it with `useLive` from " +
        "@plugins/network/plugins/live — see " +
        "plugins/network/plugins/live/CLAUDE.md. A genuine write an effect " +
        "fires is `void`-ed: what it changes reaches the page through the " +
        "live value it writes.",
      readerInRead:
        "A `LiveReader` call here runs as a read (render, a hook body, an " +
        "effect, module load, or a function they call). `useLiveReader` is " +
        "for a question an event handler asks and its own `await` consumes; " +
        "where the answer is rendered, read it with `useLive` — see " +
        "plugins/network/plugins/live/CLAUDE.md, *Event reads*.",
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

    /**
     * Whether a local named `name` is a value binding — a `const`, a
     * parameter, a destructured key — rather than an import, a function or a
     * class declared under that name.
     */
    const isValueBinding = (local: TSESTree.Identifier): boolean => {
      const def = definitionOf(local);
      if (def === undefined) return false;
      return (
        def.node.type !== "ImportSpecifier" &&
        def.type !== "FunctionName" &&
        def.type !== "ClassName"
      );
    };

    /**
     * Whether a local is bound FROM a mutation's `mutateAsync`, whatever its
     * name: a renamed destructure (`const { mutateAsync: find } = m`, a
     * parameter's `{ mutateAsync: find }`) or a member read
     * (`const run = m.mutateAsync`). Unlike `fetchEndpoint`, nothing pins a
     * `mutateAsync` binding to its name, so the rule follows where it came from.
     */
    const boundFromMutateAsync = (local: TSESTree.Identifier): boolean => {
      const def = definitionOf(local);
      if (def === undefined) return false;
      const parent = def.name.parent;
      if (
        parent?.type === "Property" &&
        parent.value === def.name &&
        parent.parent.type === "ObjectPattern" &&
        !parent.computed &&
        propertyName(parent.key) === MUTATE_ASYNC
      )
        return true;
      const node: TSESTree.Node = def.node;
      return (
        node.type === "VariableDeclarator" &&
        node.id === def.name &&
        node.init?.type === "MemberExpression" &&
        memberName(node.init) === MUTATE_ASYNC
      );
    };

    /**
     * The write client a callee names — `fetchEndpoint` (by binding name: a
     * `const fetchEndpoint = useFetchEndpoint()`, a parameter, a destructured
     * key) or `mutateAsync` (a mutation's member, a destructured local under
     * its own name or an alias, or a local assigned from the member) — or
     * null.
     */
    const writeClient = (callee: TSESTree.Node): string | null => {
      if (callee.type === "Identifier") {
        if (callee.name === FETCH_ENDPOINT || callee.name === MUTATE_ASYNC)
          return isValueBinding(callee) ? callee.name : null;
        return boundFromMutateAsync(callee) ? MUTATE_ASYNC : null;
      }
      if (callee.type === "MemberExpression")
        return memberName(callee) === MUTATE_ASYNC ? MUTATE_ASYNC : null;
      return null;
    };

    /** Whether a callee's value is a `LiveReader` (by its type). */
    const isLiveReader = (callee: TSESTree.Node): boolean => {
      if (callee.type !== "Identifier" && callee.type !== "MemberExpression")
        return false;
      // An import, a declared function or class, or a global is never a
      // reader (one comes only from `useLiveReader()`'s answer): skip the type
      // checker for them.
      if (callee.type === "Identifier" && !isValueBinding(callee)) return false;
      const { program, esTreeNodeToTSNodeMap } = typeServices();
      const type = program
        .getTypeChecker()
        .getTypeAtLocation(esTreeNodeToTSNodeMap.get(callee));
      const symbol = type.aliasSymbol ?? type.getSymbol();
      return symbol?.getName() === LIVE_READER;
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

    /** The binding a function is held by — `function f`, `const f = …`, `const f = useX(…)`. */
    const holderOf = (
      fn: FunctionNode,
    ): { declaration: TSESTree.Node; name: string } | null => {
      const parent = fn.parent;
      if (
        parent.type === "VariableDeclarator" &&
        parent.init === fn &&
        parent.id.type === "Identifier"
      )
        return { declaration: parent, name: parent.id.name };
      if (fn.type === "FunctionDeclaration" && fn.id !== null)
        return { declaration: fn, name: fn.id.name };
      if (
        parent.type === "CallExpression" &&
        parent.callee !== fn &&
        HOOK_NAME.test(calleeName(parent.callee) ?? "")
      ) {
        const holder = parent.parent;
        if (
          holder.type === "VariableDeclarator" &&
          holder.init === parent &&
          holder.id.type === "Identifier"
        )
          return { declaration: holder, name: holder.id.name };
      }
      return null;
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
          const holder = holderOf(fn);
          return holder === null
            ? "unknown"
            : runOfUses(holder.declaration, holder.name, seen);
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

    /** The variable a declaration declares under `name`. */
    const declaredVariable = (declaration: TSESTree.Node, name: string) =>
      context.sourceCode
        .getDeclaredVariables(declaration)
        .find((v) => v.name === name);

    /** How a named function runs, from every use of its binding in the file. */
    const runOfUses = (
      declaration: TSESTree.Node,
      name: string,
      seen: Set<unknown>,
    ): Run => {
      const variable = declaredVariable(declaration, name);
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

    // ── Answer used ─────────────────────────────────────────────────────

    /**
     * Whether the value `expr` evaluates to — a write's answer, or a promise
     * of it — is used (see the rule doc). `seen` breaks recursion through
     * mutually-returning named functions.
     */
    const answerUsed = (expr: TSESTree.Node, seen: Set<unknown>): boolean => {
      const parent = expr.parent;
      if (parent === undefined) return true;
      // An if-chain rather than a `switch`: `parent` is the whole
      // `TSESTree.Node` union, and `switch-exhaustiveness-check` wants every
      // member listed (a `default` does not satisfy it).
      if (parent.type === "ExpressionStatement") return false;
      if (parent.type === "UnaryExpression") return parent.operator !== "void";
      if (
        parent.type === "AwaitExpression" ||
        parent.type === "ChainExpression" ||
        parent.type === "TSAsExpression" ||
        parent.type === "TSNonNullExpression" ||
        parent.type === "TSSatisfiesExpression" ||
        parent.type === "TSTypeAssertion"
      )
        return answerUsed(parent, seen);
      if (parent.type === "SequenceExpression")
        return parent.expressions.at(-1) === expr
          ? answerUsed(parent, seen)
          : false;
      if (parent.type === "ConditionalExpression")
        return parent.test === expr || answerUsed(parent, seen);
      if (parent.type === "LogicalExpression")
        return parent.left === expr || answerUsed(parent, seen);
      if (parent.type === "MemberExpression") {
        if (parent.object !== expr) return true;
        const chained = methodCall(parent);
        if (chained === null) return true;
        if (chained.method === "catch" || chained.method === "finally")
          return answerUsed(chained.call, seen);
        if (chained.method !== "then") return true;
        const onFulfilled = chained.call.arguments[0];
        if (onFulfilled === undefined) return answerUsed(chained.call, seen);
        // `.then(() => …)` ignores the answer: its result is the callback's.
        return !isFunction(onFulfilled) || onFulfilled.params.length > 0;
      }
      if (parent.type === "CallExpression")
        // `Promise.all(items.map(…))`: the combinator's value holds it.
        return parent.arguments[0] === expr &&
          isPromiseCombinator(parent.callee)
          ? answerUsed(parent, seen)
          : true;
      if (parent.type === "ArrayExpression") {
        const call = parent.parent;
        return call.type === "CallExpression" &&
          call.arguments[0] === parent &&
          isPromiseCombinator(call.callee)
          ? answerUsed(call, seen)
          : true;
      }
      if (parent.type === "ReturnStatement") {
        for (let cur: TSESTree.Node = parent; ; cur = cur.parent) {
          if (cur.type === "Program") return true;
          if (isFunction(cur)) return returnUsed(cur, seen);
        }
      }
      if (parent.type === "ArrowFunctionExpression")
        return parent.body === expr ? returnUsed(parent, seen) : true;
      return true;
    };

    /** Whether what a function returns is used, at the places it is called. */
    const returnUsed = (fn: FunctionNode, seen: Set<unknown>): boolean => {
      const parent = fn.parent;
      if (parent.type === "CallExpression") {
        // An IIFE: its call is the value.
        if (parent.callee === fn) return answerUsed(parent, seen);
        if (firstArgumentOf(fn, RENDER_HOOKS)) return true;
        const callee = parent.callee;
        if (callee.type === "MemberExpression") {
          const method = memberName(callee);
          // `.then(() => write())` / `.map((x) => write(x))`: the outer
          // call's value holds this one's.
          if (
            method !== null &&
            (method === "then" ||
              method === "catch" ||
              method === "finally" ||
              MAPPING_METHODS.has(method))
          )
            return answerUsed(parent, seen);
        }
      }
      const holder = holderOf(fn);
      if (holder === null) return false;
      const variable = declaredVariable(holder.declaration, holder.name);
      if (variable === undefined || seen.has(variable)) return false;
      seen.add(variable);
      // Judged where this file calls it — the same uses that made it a read.
      return variable.references.some((ref) => {
        const id = ref.identifier;
        return (
          id.parent.type === "CallExpression" &&
          id.parent.callee === id &&
          answerUsed(id.parent, seen)
        );
      });
    };

    return {
      Program(node) {
        // Imports are always top-level, so every namespace local is known
        // before any read of it is visited.
        for (const stmt of node.body) {
          if (stmt.type !== "ImportDeclaration") continue;
          for (const spec of stmt.specifiers)
            if (spec.type === "ImportNamespaceSpecifier")
              moduleLocals.add(spec.local.name);
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
          if (key !== null && isReadHook(source, key)) reportHook(prop, key);
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
        const client = writeClient(node.callee);
        if (client !== null) {
          if (client === FETCH_ENDPOINT && insideQueryFn(node)) {
            context.report({ node, messageId: "queryFnFetch" });
            return;
          }
          if (runOf(node, new Set()) === "read" && answerUsed(node, new Set()))
            context.report({
              node,
              messageId: "answerRead",
              data: { name: client },
            });
          return;
        }
        // Read context first (an AST walk), so the type checker is asked
        // only about a call that would be flagged — never gated on the
        // file's text: a reader reaches a file through a hook's return, a
        // destructure or a context value without its type ever being named.
        if (runOf(node, new Set()) === "read" && isLiveReader(node.callee))
          context.report({ node, messageId: "readerInRead" });
      },
    };
  },
});
