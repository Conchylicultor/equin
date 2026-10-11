import {
  ASTUtils,
  ESLintUtils,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * no-endpoint-read
 *
 * A server read in the browser is a live resource: a `liveValue` (by `params`,
 * by a typed `query`, or key-range-`paged`) or a `liveCollection`, read with
 * `useLive`. The request/response path beside it — `useEndpoint`,
 * `useEndpointResource`, a TanStack `useQuery` family hook, or a `queryFn`
 * that calls `fetchEndpoint` — is a second read path with no push, so its
 * value goes stale or gets polled
 * (research/2026-10-09-global-live-structured-paged-values.md).
 *
 * Flags, in files under a `web/` folder:
 * - every import of a read hook from the barrel that exports it — a named
 *   import (aliases included), an `export { … } from` re-export — and every
 *   read of one off that barrel's module object (a namespace import or an
 *   awaited dynamic import, by member or by destructuring), resolved as
 *   `no-legacy-resource-spelling` does;
 * - a `fetchEndpoint(...)` call (imported from the endpoints barrel, by name
 *   or off its module object) lexically inside a `queryFn` property's value.
 *
 * An imperative `fetchEndpoint` — a mutation, an event handler — is not a
 * read and is not flagged. Test code is out of scope (a contributed rule's
 * default). The substrate that defines or wraps these hooks is exempt through
 * sanctioned entries in its plugins' `exempt/index.ts`; the remaining sites
 * are debt entries in theirs.
 */

const ENDPOINTS_WEB = "@plugins/infra/plugins/endpoints/web";

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

export default createRule({
  name: "no-endpoint-read",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow request/response server reads in the browser — declare a liveValue (params / query / paged) or a liveCollection and read it with useLive.",
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
    /** The local names that MAY be `fetchEndpoint` (imported or destructured). */
    const fetchLocals = new Set<string>();

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

    /** Whether `local` is bound to the endpoints barrel's `fetchEndpoint`. */
    const isFetchEndpointBinding = (local: TSESTree.Identifier): boolean => {
      if (!fetchLocals.has(local.name)) return false;
      const def = definitionOf(local);
      if (def === undefined) return false;
      const node: TSESTree.Node = def.node;
      if (node.type === "ImportSpecifier")
        return (
          node.parent.type === "ImportDeclaration" &&
          node.parent.source.value === ENDPOINTS_WEB &&
          propertyName(node.imported) === FETCH_ENDPOINT
        );
      // `const { fetchEndpoint: f } = m` — the destructured module object.
      if (node.type === "VariableDeclarator" && node.init !== null)
        return (
          node.id.type === "ObjectPattern" &&
          moduleBarrel(node.init) === ENDPOINTS_WEB
        );
      return false;
    };

    /** Whether a callee is the endpoints barrel's `fetchEndpoint`. */
    const isFetchEndpoint = (callee: TSESTree.Node): boolean => {
      if (callee.type === "Identifier") return isFetchEndpointBinding(callee);
      if (callee.type !== "MemberExpression") return false;
      const member =
        callee.computed && callee.property.type !== "Literal"
          ? null
          : propertyName(callee.property);
      return (
        member === FETCH_ENDPOINT &&
        moduleBarrel(callee.object) === ENDPOINTS_WEB
      );
    };

    return {
      Program(node) {
        // Imports are always top-level, so every namespace / fetchEndpoint
        // local is known before any read of it is visited.
        for (const stmt of node.body) {
          if (stmt.type !== "ImportDeclaration") continue;
          for (const spec of stmt.specifiers) {
            if (spec.type === "ImportNamespaceSpecifier")
              moduleLocals.add(spec.local.name);
            else if (
              spec.type === "ImportSpecifier" &&
              stmt.source.value === ENDPOINTS_WEB &&
              propertyName(spec.imported) === FETCH_ENDPOINT
            )
              fetchLocals.add(spec.local.name);
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
            source === ENDPOINTS_WEB &&
            key === FETCH_ENDPOINT &&
            prop.value.type === "Identifier"
          )
            fetchLocals.add(prop.value.name);
        }
      },

      MemberExpression(node) {
        const source = moduleBarrel(node.object);
        if (source === null) return;
        const member =
          node.computed && node.property.type !== "Literal"
            ? null
            : propertyName(node.property);
        if (member !== null && isReadHook(source, member))
          reportHook(node, member);
      },

      CallExpression(node) {
        if (isFetchEndpoint(node.callee) && insideQueryFn(node))
          context.report({ node, messageId: "queryFnFetch" });
      },
    };
  },
});
