import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

/**
 * no-core-define-route-in-web
 *
 * `defineRoute` is reachable from BOTH pane barrels — it is authored in `core/`
 * (runtime-agnostic: a server plugin builds the same app-rooted link from it)
 * and re-exported from `web/` so a pane file states its identity and its
 * behavior in one import. Two legal paths for one symbol is two spellings of
 * the same thing, which is the tax this re-export exists to remove; so the
 * canonical path is pinned per runtime:
 *
 *   • a file under `web/`  → `@plugins/primitives/plugins/pane/web`
 *   • a file under `core/` or `shared/` → `@plugins/primitives/plugins/pane/core`
 *
 * Only the first half is enforced here, because only the first half can happen:
 * the boundary config gives `core` the zone `["core"]`, so a `core/` or
 * `shared/` file importing the WEB barrel is already a hard `plugin-boundaries`
 * failure. A rule firing there would restate an error the checker already
 * raises. What is left is a `web/` file reaching past the barrel it is already
 * importing `Pane` from — legal to the boundary checker, and exactly the extra
 * import line this rule removes.
 *
 * Scope is deliberately narrow: it fires only on the `defineRoute` VALUE, only
 * on the pane core barrel's cross-plugin specifier, only in a `web/` runtime
 * folder. `import type { RouteDef }` / `{ normalizeRoutePath }` / `{ AppRef }`
 * from the core barrel stay legal in `web/` — those are not re-exported here,
 * so there is no second spelling to choose between.
 *
 * The pane plugin's own tree is exempt (`pane/exempt/index.ts`): its correct
 * spelling is the relative `../core`, and the barrel doing the re-export must
 * not be flagged for performing it.
 */

const createRule = lintRuleCreator(import.meta.url);

/** The pane plugin's runtime barrels, by cross-plugin specifier. */
const PANE_CORE = "@plugins/primitives/plugins/pane/core";
const PANE_WEB = "@plugins/primitives/plugins/pane/web";

/** The one symbol both barrels expose, and so the one that needs a canonical path. */
const ROUTE_FACTORY = "defineRoute";

/** Normalize to `/` separators — the rule reasons in posix segments. */
function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/**
 * Walk the alternating `<name>(/plugins/<name>)*` grammar a plugin dir follows,
 * from `segs[start]`, and return the index of the plugin dir's LAST segment.
 * The same walk as `runtime-isolation`'s `own-tree.ts`, copied rather than
 * imported: `jiti` cannot resolve `@plugins/*` inside a lint rule file.
 */
function pluginDirEnd(segs: string[], start: number): number {
  let i = start;
  while (segs[i + 1] === "plugins" && segs[i + 2] !== undefined) i += 2;
  return i;
}

/**
 * The runtime folder (`web`, `core`, `server`, …) an absolute source file sits
 * in, or null when it is not inside a plugin. Segment arithmetic, not a
 * substring match, so a `web/` directory NESTED under another runtime folder
 * (`core/web/…`) is not mistaken for the web runtime.
 */
function runtimeFolderOf(absPath: string): string | null {
  const segs = toPosix(absPath).split("/");
  const pluginsRoot = segs.indexOf("plugins");
  if (pluginsRoot === -1 || segs[pluginsRoot + 1] === undefined) return null;
  return segs[pluginDirEnd(segs, pluginsRoot + 1) + 1] ?? null;
}

export default createRule({
  name: "no-core-define-route-in-web",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing defineRoute from the pane CORE barrel inside a web/ file — " +
        "the web barrel re-exports it, so a pane's identity and its behavior arrive in " +
        "one import.",
    },
    schema: [],
    messages: {
      wrongBarrel:
        "Import `defineRoute` from `" +
        PANE_WEB +
        "` here, not `" +
        PANE_CORE +
        "`. The web barrel re-exports it, so a `web/` file declaring a pane " +
        "needs ONE pane import, not two — `Pane.define({ route: defineRoute({…}) })` " +
        "from a single specifier. (`core/` and `shared/` files keep using the core " +
        "barrel; the boundary checker already stops them reaching web.)",
    },
  },
  defaultOptions: [],
  create(context) {
    const file = toPosix(context.filename ?? context.getFilename?.() ?? "");
    if (runtimeFolderOf(file) !== "web") return {};

    // Local names bound to `import * as paneCore from "…/pane/core"` — member
    // access on these to the factory is flagged too, as in `no-adhoc-check-runner`.
    const nsLocals = new Set<string>();

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (node.importKind === "type") return;
        if (node.source.value !== PANE_CORE) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            if (spec.importKind === "type") continue;
            if (
              spec.imported.type === "Identifier" &&
              spec.imported.name === ROUTE_FACTORY
            ) {
              context.report({ node: spec, messageId: "wrongBarrel" });
            }
          } else if (spec.type === "ImportNamespaceSpecifier") {
            nsLocals.add(spec.local.name);
          }
        }
      },
      // `paneCore.defineRoute(…)` on a namespace import of the core barrel.
      MemberExpression(node: TSESTree.MemberExpression) {
        if (node.object.type !== "Identifier") return;
        if (!nsLocals.has(node.object.name)) return;
        const prop =
          node.property.type === "Identifier"
            ? node.property.name
            : node.property.type === "Literal" &&
                typeof node.property.value === "string"
              ? node.property.value
              : null;
        if (prop === ROUTE_FACTORY) {
          context.report({ node, messageId: "wrongBarrel" });
        }
      },
    };
  },
});
