import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import {
  PLUGIN_FOLDERS,
  type PluginFolder,
} from "@plugins/framework/plugins/plugin-id/core";
import boundaryConfig from "../core/boundary-config";
import { isPlatformApi } from "../core/platform-apis";

/**
 * no-platform-api
 *
 * A file in a folder whose `platformApis` row (`core/boundary-config.ts`) is
 * `"forbidden"` — `server/`, `core/`, `shared/`, `web/` — may not import a
 * platform API (`core/platform-apis.ts`: Node builtins, `bun`, `pg`, graphile,
 * native watchers). Those folders hold the code every host runs, the browser
 * included; the code that needs the computer lives in `machine/` (or `central/`,
 * a CLI verb, …), where the row is `"allowed"`.
 *
 * Every way a module is loaded counts: a static import or re-export, `import()`
 * and `require()`. A type-only import is allowed — it erases (`import type`,
 * or an import whose every specifier is `type`).
 *
 * Exemptable per file (`tooling/exempt`): the code that has not been split into
 * `server/` + `machine/` yet carries a `debt` exemption naming its task, so a
 * NEW platform import elsewhere in the same plugin still fails. A plugin whose
 * whole server closure is portable says so with `portable: true`, which the
 * `boundaries:portable-closure` check proves transitively.
 */

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

const FOLDERS: ReadonlySet<string> = new Set(PLUGIN_FOLDERS);

/**
 * The plugin folder an absolute source file sits in: the segment after its
 * plugin dir, which follows the alternating `plugins/<name>(/plugins/<name>)*`
 * grammar. Null outside `plugins/` or in a folder outside the vocabulary (the
 * boundary-rules check reports that one).
 */
function folderOf(filename: string): PluginFolder | null {
  const segs = filename.split("\\").join("/").split("/");
  let i = segs.indexOf("plugins");
  if (i === -1 || segs[i + 1] === undefined) return null;
  i += 1;
  while (segs[i + 1] === "plugins" && segs[i + 2] !== undefined) i += 2;
  const folder = segs[i + 1];
  // The last segment is the file itself, never a folder.
  if (folder === undefined || i + 1 === segs.length - 1) return null;
  return FOLDERS.has(folder) ? (folder as PluginFolder) : null;
}

export default createRule({
  name: "no-platform-api",
  meta: {
    type: "problem",
    docs: {
      description:
        "In server/, core/, shared/ and web/, import no platform API (Node builtins, bun, " +
        "pg, graphile-worker, @parcel/watcher, …) — that code runs on every host, the " +
        "browser included. Code that needs the computer goes in machine/.",
    },
    schema: [],
    messages: {
      platformApi:
        '`{{folder}}/` imports the platform API "{{specifier}}". `{{folder}}/` code must run ' +
        "on every host, the browser included, so it may not reach the computer's " +
        "filesystem, processes, sockets or the Postgres client. Move the code that needs it " +
        "into this plugin's `machine/` (and reach it through a host service or a machine " +
        "route), or import only its types with `import type`.",
    },
  },
  defaultOptions: [],
  create(context) {
    const folder = folderOf(context.filename);
    if (folder === null || boundaryConfig.platformApis[folder] !== "forbidden")
      return {};

    const check = (node: TSESTree.Node, specifier: unknown): void => {
      if (typeof specifier !== "string" || !isPlatformApi(specifier)) return;
      context.report({
        node,
        messageId: "platformApi",
        data: { folder, specifier },
      });
    };

    return {
      ImportDeclaration: (node): void => {
        if (node.importKind === "type") return;
        if (
          node.specifiers.length > 0 &&
          node.specifiers.every(
            (s) => s.type === "ImportSpecifier" && s.importKind === "type",
          )
        )
          return;
        check(node, node.source.value);
      },
      ExportNamedDeclaration: (node): void => {
        if (node.source === null || node.exportKind === "type") return;
        check(node, node.source.value);
      },
      ExportAllDeclaration: (node): void => {
        if (node.exportKind === "type") return;
        check(node, node.source.value);
      },
      ImportExpression: (node): void => {
        if (node.source.type === "Literal") check(node, node.source.value);
      },
      TSImportEqualsDeclaration: (node): void => {
        if (
          node.importKind === "type" ||
          node.moduleReference.type !== "TSExternalModuleReference"
        )
          return;
        check(node, node.moduleReference.expression.value);
      },
      CallExpression: (node): void => {
        const arg = node.arguments[0];
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          arg?.type === "Literal"
        )
          check(node, arg.value);
      },
    };
  },
});
