/**
 * Bans importing zod through a version subpath — `zod/v3`, `zod/v4`,
 * `zod/v4/core`, `zod/v4/mini`, `zod/mini`, or any other `zod/…` specifier.
 *
 * Every schema in the repo is built from `"zod"`, the one version the root
 * package.json installs. A subpath is ANOTHER version's API: its schemas do
 * not compose with the rest (a zod 3 schema cannot sit inside a zod 4
 * `z.object`), its internals are a different shape, and the web vendor set
 * grows a second zod. The zod 3 → 4 migration
 * (`research/2026-10-28-global-zod-4-migration.md`) moves the whole repo at
 * once, by changing what `"zod"` resolves to — never file by file through a
 * subpath. Only `packages/zod-introspect`, which reads both versions' schemas,
 * names one (its `exempt/index.ts`).
 *
 * Every form that names a module is checked: `import` (type-only included),
 * `export … from`, `import("…")`, `require("…")` and a `typeof import("…")`
 * type. Self-contained by necessity — the ESLint config loads rule files
 * through jiti, which cannot resolve `@plugins/*`.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** A `zod/…` specifier: a version (or build) subpath of the zod package. */
export function isZodSubpath(specifier: string): boolean {
  return specifier.startsWith("zod/");
}

export default createRule({
  name: "no-zod-subpath",
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow importing zod through a version subpath (`zod/v3`, `zod/v4`, `zod/v4/core`, `zod/mini`, …) — import `"zod"`.',
    },
    schema: [],
    messages: {
      zodSubpath:
        "`{{specifier}}` is another zod version's API: its schemas do not compose with the repo's (built from `\"zod\"`), " +
        'and it adds a second zod to the web vendor set. Import `"zod"`. A schema\'s internals are read through ' +
        "`@plugins/packages/plugins/zod-introspect/core` (`inspect`), never through a zod subpath.",
    },
  },
  defaultOptions: [],
  create(context) {
    const check = (source: TSESTree.Node | null | undefined): void => {
      if (
        source?.type === "Literal" &&
        typeof source.value === "string" &&
        isZodSubpath(source.value)
      ) {
        context.report({
          node: source,
          messageId: "zodSubpath",
          data: { specifier: source.value },
        });
      }
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => {
        const arg = node.argument;
        if (arg.type === "TSLiteralType") check(arg.literal);
      },
      TSExternalModuleReference: (node) => check(node.expression),
      CallExpression: (node) => {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length === 1
        ) {
          check(node.arguments[0]);
        }
      },
    };
  },
});
