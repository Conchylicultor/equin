import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";
import { locate, ownTargetOf, toPosix } from "./own-tree";

/**
 * no-deep-own-folder-import
 *
 * A file that ships in a browser artifact may reach a SIBLING folder of its own
 * plugin only through that folder's barrel: `../../core`, never
 * `../../core/merge-group-values`.
 *
 * The web-artifact builder routes every import that lands in one of the
 * plugin's own non-inlined folders — the barrel AND any deep file — to that
 * folder's `@plugins/<own>/<folder>` barrel artifact (`ownFolderBarrelPlugin`,
 * web-artifacts `core/internal/vite-builder.ts`). It has to: inlining a private
 * copy of `core/x` next to the core artifact every other plugin loads would give
 * the page two instances of its module state. So in the browser a deep import
 * MEANS the barrel, while `tsc` reads it as the file. Whenever the symbol is not
 * in the barrel the two disagree, every check passes, and the build fails ~5
 * minutes in at compose (`"…/theme-engine/core" does not export
 * "mergeGroupValues"` — the outage this rule was written for). Spelled as the
 * barrel, the import means the same thing to both, and a missing export is an
 * ordinary type error in the editor.
 *
 * Scope:
 *   - Importers: `web/`, `core/`, `shared/`, `exhibits/` — the folders that
 *     end up in browser artifacts (`shared/` is inlined into each). A
 *     `server/` or `check/` file runs under Bun, which loads the file
 *     itself, so its deep imports mean what they say.
 *   - The one exemption: `exhibits/` may deep-import its own `web/`. It is not
 *     an artifact of its own but a second entry of the plugin's web artifact
 *     (`COBUILT_FOLDERS` in web-artifacts `core/own-roots.ts`), so `web/` is
 *     inlined into the same build and the deep path means the file in the
 *     browser exactly as it does to `tsc`. Every other deep import from
 *     `exhibits/` (`../core/x`) is still routed to a barrel and still rejected.
 *   - Targets: any other top-level folder of the same plugin, except `shared/`
 *     (inlined into every artifact, usually barrel-less), `plugins/` (other
 *     plugins — the boundary check's business) and `node_modules/`. CSS and
 *     `?query` imports are skipped exactly as the builder skips them.
 *   - Type-only imports included: a type that crosses a folder is that folder's
 *     public API, and belongs in its barrel like any other export.
 *
 * The autofix rewrites the specifier to the barrel — the module the browser
 * already loads, so it changes nothing at runtime; `tsc` then names any symbol
 * the barrel still has to export.
 */

const createRule = lintRuleCreator(import.meta.url);

/** Top-level plugin folders whose files are bundled into browser artifacts. */
const BROWSER_BUILT = new Set(["web", "core", "shared", "exhibits"]);

/**
 * Importer folder → the own folder it is co-built with, which it may therefore
 * enter deeply. Mirrors web-artifacts' `COBUILT_FOLDERS` (lint rules import no
 * plugin runtime code).
 */
const CO_BUILT_WITH: Readonly<Record<string, string>> = { exhibits: "web" };

/** Own folders a deep import may enter: not routed to a barrel by the builder. */
const OPEN_FOLDERS = new Set(["shared", "plugins", "node_modules"]);

/** Spellings that ARE the barrel: the folder itself, or its index file. */
const BARREL_TAILS = new Set(["index", "index.ts", "index.tsx", "index.js"]);

function isBarrel(rest: readonly string[]): boolean {
  return rest.length === 0 || (rest.length === 1 && BARREL_TAILS.has(rest[0]!));
}

/**
 * The barrel spelling of a deep specifier: the same specifier with the
 * below-folder segments dropped, so a relative import stays relative and a
 * self-specifier stays one. Null when the specifier's tail does not spell those
 * segments literally (a `../web/../core/x` detour) — reported without a fix.
 */
function barrelSpecifier(
  specifier: string,
  rest: readonly string[],
): string | null {
  const segs = specifier.split("/");
  const tail = segs.slice(segs.length - rest.length);
  if (tail.join("/") !== rest.join("/")) return null;
  return segs.slice(0, segs.length - rest.length).join("/");
}

export default createRule({
  name: "no-deep-own-folder-import",
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "In browser-built folders (web/, core/, shared/, exhibits/), import a sibling " +
        "folder of the same plugin through its barrel, never a file inside it — the " +
        "web-artifact build rewrites the deep import to the barrel, so a symbol the " +
        "barrel does not export type-checks and then fails the build.",
    },
    schema: [],
    messages: {
      deepImport:
        '`{{from}}/` imports a file inside this plugin\'s own `{{to}}/` (import "{{specifier}}"). ' +
        "The browser build rewrites that to the `{{to}}/` barrel — it cannot inline the file " +
        "without a second copy of its module state — so a symbol `{{to}}/index.ts` does not " +
        "export passes type-check here and fails `./equin build` at compose. Import from " +
        '"{{barrel}}" and export the symbol from `{{to}}/index.ts`.',
    },
  },
  defaultOptions: [],
  create(context) {
    const file = toPosix(context.filename);
    const source = locate(file);
    if (source === null || !BROWSER_BUILT.has(source.folder)) return {};

    const check = (
      node: TSESTree.Node,
      literal: TSESTree.StringLiteral,
      fixable: boolean,
    ): void => {
      const specifier = literal.value;
      if (specifier.includes("?") || specifier.endsWith(".css")) return;
      const target = ownTargetOf(specifier, file, source);
      if (target === null) return;
      if (target.folder === source.folder) return;
      if (CO_BUILT_WITH[source.folder] === target.folder) return;
      if (OPEN_FOLDERS.has(target.folder)) return;
      if (isBarrel(target.rest)) return;
      const barrel = barrelSpecifier(specifier, target.rest);
      context.report({
        node,
        messageId: "deepImport",
        data: {
          from: source.folder,
          to: target.folder,
          specifier,
          barrel: barrel ?? `<path to ${target.folder}/>`,
        },
        fix:
          fixable && barrel !== null
            ? (fixer) => {
                const quote = literal.raw[0] ?? '"';
                return fixer.replaceText(literal, `${quote}${barrel}${quote}`);
              }
            : null,
      });
    };

    return {
      ImportDeclaration: (node): void => check(node, node.source, true),
      ExportNamedDeclaration: (node): void => {
        if (node.source !== null) check(node, node.source, true);
      },
      // `export *` from the barrel re-exports a different name set than from
      // the file, so the fix is left to the author.
      ExportAllDeclaration: (node): void => check(node, node.source, false),
      ImportExpression: (node): void => {
        if (
          node.source.type !== "Literal" ||
          typeof node.source.value !== "string"
        )
          return;
        check(node, node.source as TSESTree.StringLiteral, true);
      },
    };
  },
});
