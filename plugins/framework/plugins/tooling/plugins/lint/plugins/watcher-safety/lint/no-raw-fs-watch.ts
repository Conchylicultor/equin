import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

// The runtime folders whose code runs in a host process: a backend, central,
// the code both share, a CLI command, and the process entry points.
const SCOPED_SEGMENTS = ["/server/", "/central/", "/shared/", "/cli/", "/bin/"];

function inScope(filename: string): boolean {
  if (
    filename.endsWith(".test.ts") ||
    filename.endsWith(".spec.ts") ||
    filename.includes("/__tests__/") ||
    filename.includes("/testing/")
  ) {
    return false;
  }
  return SCOPED_SEGMENTS.some((s) => filename.includes(s));
}

const FS_MODULES = new Set(["fs", "node:fs"]);
const FS_PROMISES_MODULES = new Set(["fs/promises", "node:fs/promises"]);
/** The watch APIs of `fs` (callback / sync). */
const FS_WATCH_NAMES = new Set(["watch", "watchFile", "unwatchFile"]);

function isChokidar(source: string): boolean {
  return source === "chokidar" || source.startsWith("chokidar/");
}

function propertyName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return null;
}

export default createRule({
  name: "no-raw-fs-watch",
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban `fs.watch` / `fs.watchFile` / `fs.promises.watch` and chokidar in " +
        "server, central, shared, cli and bin code. A file watcher is declared " +
        "with `defineFileWatcher` (`@plugins/infra/plugins/file-watcher/server`) " +
        "— named, described, and listed in Debug → Background activity with its " +
        "open instances, backend and runs — or, for a foreground CLI command, " +
        "opened with `watchForCommand` (`@plugins/infra/plugins/file-watcher/cli`). " +
        "The few sites that cannot (declared in their plugins' `exempt/index.ts`) each " +
        "carry their reason.",
    },
    schema: [],
    messages: {
      rawFsWatch:
        "Raw `{{api}}` is not allowed in server/central/shared/cli/bin code. " +
        "Declare the watcher with `defineFileWatcher` (infra/file-watcher/server) " +
        "so it is tracked and listed in Background activity — or use " +
        "`watchForCommand` (infra/file-watcher/cli) for a foreground command. " +
        "An exception belongs in the exempted plugin's `exempt/index.ts`, with its reason.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = (context.filename ?? "").split("\\").join("/");
    if (!inScope(filename)) return {};

    // Local names bound to the `fs` module (default / namespace imports) and
    // to `fs/promises` (or `fs.promises`), so `x.watch` can be read back.
    const fsNamespaces = new Set<string>();
    const fsPromisesNamespaces = new Set<string>();

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        const source = node.source.value;
        if (isChokidar(source)) {
          context.report({
            node,
            messageId: "rawFsWatch",
            data: { api: "chokidar" },
          });
          return;
        }
        const isFs = FS_MODULES.has(source);
        const isFsPromises = FS_PROMISES_MODULES.has(source);
        if (!isFs && !isFsPromises) return;
        for (const spec of node.specifiers) {
          if (
            spec.type === "ImportDefaultSpecifier" ||
            spec.type === "ImportNamespaceSpecifier"
          ) {
            (isFs ? fsNamespaces : fsPromisesNamespaces).add(spec.local.name);
            continue;
          }
          if (spec.importKind === "type") continue;
          const imported =
            spec.imported.type === "Identifier"
              ? spec.imported.name
              : spec.imported.value;
          if (isFs && FS_WATCH_NAMES.has(imported)) {
            context.report({
              node: spec,
              messageId: "rawFsWatch",
              data: { api: `fs.${imported}` },
            });
          } else if (isFs && imported === "promises") {
            fsPromisesNamespaces.add(spec.local.name);
          } else if (isFsPromises && imported === "watch") {
            context.report({
              node: spec,
              messageId: "rawFsWatch",
              data: { api: "fs.promises.watch" },
            });
          }
        }
      },
      MemberExpression(node) {
        const name = propertyName(node);
        if (name === null) return;
        const object = node.object;
        // `fs.watch`, `fs.watchFile`, `fs.unwatchFile` on an fs namespace.
        if (object.type === "Identifier") {
          if (fsNamespaces.has(object.name) && FS_WATCH_NAMES.has(name)) {
            context.report({
              node,
              messageId: "rawFsWatch",
              data: { api: `fs.${name}` },
            });
          } else if (
            fsPromisesNamespaces.has(object.name) &&
            name === "watch"
          ) {
            context.report({
              node,
              messageId: "rawFsWatch",
              data: { api: "fs.promises.watch" },
            });
          }
          return;
        }
        // `fs.promises.watch`.
        if (
          name === "watch" &&
          object.type === "MemberExpression" &&
          object.object.type === "Identifier" &&
          fsNamespaces.has(object.object.name) &&
          propertyName(object) === "promises"
        ) {
          context.report({
            node,
            messageId: "rawFsWatch",
            data: { api: "fs.promises.watch" },
          });
        }
      },
      // `require("chokidar")` / `import("chokidar")`.
      CallExpression(node) {
        const arg = node.arguments[0];
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          arg?.type === "Literal" &&
          typeof arg.value === "string" &&
          isChokidar(arg.value)
        ) {
          context.report({
            node,
            messageId: "rawFsWatch",
            data: { api: "chokidar" },
          });
        }
      },
      ImportExpression(node) {
        if (
          node.source.type === "Literal" &&
          typeof node.source.value === "string" &&
          isChokidar(node.source.value)
        ) {
          context.report({
            node,
            messageId: "rawFsWatch",
            data: { api: "chokidar" },
          });
        }
      },
    };
  },
});
