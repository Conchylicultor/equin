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
 * no-legacy-resource-spelling
 *
 * The unified live-resource API (`plugins/network/plugins/live`) replaces the
 * twelve older ways to declare, serve and read a live resource with three
 * pairs: `liveValue` / `serveValue` / `useLive`, and `liveCollection` /
 * `serveCollection` / `useLive` / `useLiveRow`. The old spellings that still
 * exist stay only as the substrate the new ones compile to; the deleted ones
 * stay listed so a stale import is told its replacement
 * (research/2026-10-08-global-page-tree-and-agents-routed.md).
 *
 * Flags every import of an old spelling from the barrel that exports it — a
 * named import (aliases included), an `export { … } from` re-export — and every
 * read of one off that barrel's module object: a namespace import
 * (`import * as m`) or an awaited dynamic import (`await import(…)`, bound or
 * not), read by member (`m.useResource`, `m["useResource"]`) or by
 * destructuring (`const { useResource } = m`). A call needs one of those, so
 * this covers every call. The module object is resolved through scope, so a
 * local that shadows it is not flagged. A type position (`typeof m.x`) calls
 * nothing and is not flagged. Only the substrate plugins are exempt, through
 * sanctioned entries in their plugins' `exempt/index.ts`.
 */

/** Each old spelling → the unified spelling that replaces it. */
const REPLACEMENT = {
  resourceDescriptor: "`liveValue` (one payload) or `liveCollection` (rows)",
  keyedResourceDescriptor: "`liveCollection`",
  queryResourceDescriptor: "`liveCollection`",
  windowQueryResourceDescriptor: "`liveCollection`",
  pointQueryResourceDescriptor:
    "`liveCollection(key, { row, id })` (lookup-only)",
  defineResource: "`serveValue` or `serveCollection`",
  defineExternalResource: '`serveValue(v, { source: "external", … })`',
  queryResource: "`serveCollection`",
  windowQueryResource: "`serveCollection`",
  useResource: "`useLive`",
  usePointResource: "`useLiveRow`",
  usePointResources: "`useLive(c, { ids })`",
  useWindowResource: "`useLive(c, query)`",
  // The deferred and multi-tuple substrate the paged read and the exposing /
  // scoped collections compile to (not a fourth way to declare, serve or read
  // one).
  defineDeferredResource:
    "`serveCollection` (an exposing / `columnScope` collection binds deferred)",
  deferredWindowQueryResource: "`serveCollection`",
  useResources:
    "`useLive` (a scrolled list: a DataView `liveDataSource`, which reads `useLive(c, query, { viewport })`)",
} as const;

type LegacyName = keyof typeof REPLACEMENT;

/**
 * The barrels that export an old spelling, and which ones each exports — or
 * exported: a deleted spelling stays listed, so a stale import (copied from an
 * old doc or branch) is told its replacement, not only tsc's "no exported
 * member".
 */
const LEGACY_BARRELS: Readonly<Record<string, readonly LegacyName[]>> = {
  "@plugins/primitives/plugins/live-state/core": [
    "resourceDescriptor",
    "keyedResourceDescriptor",
  ],
  "@plugins/primitives/plugins/live-state/web": [
    "resourceDescriptor",
    "keyedResourceDescriptor",
    "useResource",
    "useResources",
    // Deleted at the phase-3 Wave 3 barrier; kept so a stale import is flagged.
    "usePointResource",
    "usePointResources",
    // Deleted at the phase-3 Wave 4 barrier; kept so a stale import is flagged.
    "useWindowResource",
  ],
  "@plugins/infra/plugins/query-resource/core": [
    "queryResourceDescriptor",
    // Moved into network/live (internal) at the phase-3 Wave 7 barrier; kept
    // so a stale import is flagged.
    "windowQueryResourceDescriptor",
    "pointQueryResourceDescriptor",
  ],
  "@plugins/infra/plugins/query-resource/server": [
    "queryResource",
    "windowQueryResource",
    "deferredWindowQueryResource",
  ],
  "@plugins/framework/plugins/server-core/core": [
    "defineResource",
    "defineExternalResource",
    "defineDeferredResource",
  ],
  "@plugins/framework/plugins/central-core/core": [
    "defineResource",
    "defineExternalResource",
  ],
};

/** The old spelling `name` is, when `source` is the barrel that exports it. */
function legacyName(source: string, name: string): LegacyName | null {
  const names = LEGACY_BARRELS[source];
  if (names === undefined) return null;
  return names.find((n) => n === name) ?? null;
}

function propertyName(node: TSESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  return null;
}

/** The legacy barrel `import("<barrel>")` loads, or null. */
function dynamicImportBarrel(node: TSESTree.Node): string | null {
  if (node.type !== "ImportExpression") return null;
  const source = node.source;
  if (source.type !== "Literal" || typeof source.value !== "string")
    return null;
  return LEGACY_BARRELS[source.value] === undefined ? null : source.value;
}

/** The legacy barrel an `await import("<barrel>")` evaluates to, or null. */
function awaitedImportBarrel(node: TSESTree.Node | null): string | null {
  if (node?.type !== "AwaitExpression") return null;
  return dynamicImportBarrel(node.argument);
}

export default createRule({
  name: "no-legacy-resource-spelling",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the legacy live-resource spellings — declare, serve and read through network/live (liveValue / liveCollection, serveValue / serveCollection, useLive / useLiveRow).",
    },
    schema: [],
    messages: {
      legacySpelling:
        "`{{name}}` is a legacy live-resource spelling. Use {{replacement}} " +
        "from @plugins/network/plugins/live instead (declare in core, serve in " +
        "server, read in web) — see plugins/network/plugins/live/CLAUDE.md. " +
        "The files still on the old spellings are this rule's burndown list " +
        "in plugins/network/plugins/live/lint/index.ts: migrate, never add one.",
    },
  },
  defaultOptions: [],
  create(context) {
    const report = (node: TSESTree.Node, name: LegacyName) => {
      context.report({
        node,
        messageId: "legacySpelling",
        data: { name, replacement: REPLACEMENT[name] },
      });
    };

    /**
     * The local names that MAY hold a legacy barrel's module object — a cheap
     * pre-filter, so scope is resolved only for a read off one of them.
     */
    const moduleLocals = new Set<string>();

    /** The legacy barrel `local` holds the module object of, or null. */
    const boundBarrel = (local: TSESTree.Identifier): string | null => {
      if (!moduleLocals.has(local.name)) return null;
      const scope: TSESLint.Scope.Scope = context.sourceCode.getScope(local);
      const def = ASTUtils.findVariable(scope, local)?.defs[0];
      if (def === undefined) return null;
      const node: TSESTree.Node = def.node;
      if (node.type === "ImportNamespaceSpecifier") {
        const source = node.parent.source.value;
        return LEGACY_BARRELS[source] === undefined ? null : source;
      }
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier")
        return awaitedImportBarrel(node.init);
      return null;
    };

    /** The legacy barrel an expression evaluates to the module object of. */
    const moduleBarrel = (node: TSESTree.Node): string | null =>
      node.type === "Identifier"
        ? boundBarrel(node)
        : awaitedImportBarrel(node);

    return {
      Program(node) {
        // Imports are always top-level, so every namespace local is known
        // before any read of it is visited.
        for (const stmt of node.body) {
          if (stmt.type !== "ImportDeclaration") continue;
          for (const spec of stmt.specifiers) {
            if (spec.type === "ImportNamespaceSpecifier")
              moduleLocals.add(spec.local.name);
          }
        }
      },

      ImportDeclaration(node) {
        const source = node.source.value;
        if (LEGACY_BARRELS[source] === undefined) return;
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier") continue;
          const imported = propertyName(spec.imported);
          const name = imported === null ? null : legacyName(source, imported);
          if (name !== null) report(spec, name);
        }
      },

      ExportNamedDeclaration(node) {
        if (node.source === null) return;
        const source = node.source.value;
        for (const spec of node.specifiers) {
          // `local` is the name on the source side of `export { local as x }`.
          const exported = propertyName(spec.local);
          const name = exported === null ? null : legacyName(source, exported);
          if (name !== null) report(spec, name);
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
        // `const { useResource } = m` / `= await import("<barrel>")`.
        if (node.id.type !== "ObjectPattern") return;
        const source = moduleBarrel(node.init);
        if (source === null) return;
        for (const prop of node.id.properties) {
          if (prop.type !== "Property") continue;
          const key =
            prop.computed && prop.key.type !== "Literal"
              ? null
              : propertyName(prop.key);
          const name = key === null ? null : legacyName(source, key);
          if (name !== null) report(prop, name);
        }
      },

      MemberExpression(node) {
        const source = moduleBarrel(node.object);
        if (source === null) return;
        const member =
          node.computed && node.property.type !== "Literal"
            ? null
            : propertyName(node.property);
        const name = member === null ? null : legacyName(source, member);
        if (name !== null) report(node, name);
      },
    };
  },
});
