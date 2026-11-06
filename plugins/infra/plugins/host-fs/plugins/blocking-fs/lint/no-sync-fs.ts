import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The plugin folders whose code runs on a long-lived backend's JS thread: a
 * worktree backend (`server/`, `machine/`), central (`central/`) and the
 * on-demand dependency installers both call (`deps/`). A folder right below
 * a plugin dir, so a plugin NAMED `deps` (or a checkout under a `…/server/`
 * dir) is not all backend code.
 */
const BACKEND_FOLDER =
  /(?:^|\/)plugins\/[^/]+\/(?:server|machine|central|deps)\//;

const FS_MODULE = /\/@types\/node\/fs\.d\.ts$/;
const BUN_TYPES = /\/bun-types\//;
const TIMED_FS = "plugins/packages/plugins/timed-fs/";

/**
 * no-sync-fs
 *
 * A backend's JS thread never waits on the disk. A synchronous fs call
 * (`readFileSync`, `renameSync`, `openSync`, `readdirSync`, … — node's own
 * or timed-fs's twin, which carries node's declaration), a `Bun.resolveSync`
 * (it stats its way up the `node_modules` chain) or a synchronous glob scan
 * holds the thread for as long as the disk takes to answer — on a busy or
 * slow disk, seconds. Every request, live read, job and timer of the process
 * waits behind it, and every other op in flight is recorded as slow
 * (research/2026-11-06-global-no-sync-fs-on-backends.md: 3–13.6 s stalls on
 * main, `renameSync ← writeAtomic`, `openSync ← readTail`,
 * `resolveSync ← resolvePlaywright`, `statSync ← fileStamp`, …).
 *
 * Reported in `server/`, `machine/` and `central/` code (not tests, `cli/`,
 * `scripts/`, `bin/`, `provision/`). Use the `node:fs/promises` call
 * (timed-fs's async twin). A file that runs only where a blocked thread
 * harms nobody — before the backend listens, in its own child process, in a
 * synchronous `exit` handler — declares it: a `sanctioned` exemption in its
 * plugin's `exempt/index.ts`, with the reason.
 */
export default createRule({
  name: "no-sync-fs",
  meta: {
    type: "problem",
    docs: {
      description:
        "No synchronous fs call (node:fs *Sync, Bun.resolveSync, a sync glob scan) on a backend's JS thread: a slow disk turns its latency into a frozen process.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      sync: "`{{name}}` blocks the backend's JS thread until the disk answers — 3–13 s on a busy disk, every request and live read of the process frozen behind it. Use the async `node:fs/promises` twin (from timed-fs). Code that runs only before the backend listens, in its own child process or in a synchronous exit handler declares a `sanctioned` `blocking-fs/no-sync-fs` exemption in its plugin's exempt/index.ts.",
    },
  },
  defaultOptions: [],
  create(context) {
    const file = context.filename;
    const inRepo = file.startsWith(context.cwd)
      ? file.slice(context.cwd.length)
      : file;
    if (!BACKEND_FOLDER.test(inRepo)) return {};
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const toTs = services.esTreeNodeToTSNodeMap;

    /** The blocking call a call expression invokes, if it does. */
    const blocking = (call: TSESTree.CallExpression): string | undefined => {
      const decl = checker.getResolvedSignature(
        toTs.get(call) as ts.CallLikeExpression,
      )?.declaration;
      if (decl === undefined) return undefined;
      const source = decl.getSourceFile().fileName;
      // `realpathSync.native` is `native` inside `namespace realpathSync`:
      // the name is the nearest enclosing one ending in `Sync`.
      for (let n: ts.Node | undefined = decl; n !== undefined; n = n.parent) {
        if (ts.isSourceFile(n)) break;
        const own = (n as ts.FunctionDeclaration).name?.getText();
        if (own === undefined) continue;
        if (FS_MODULE.test(source) && own.endsWith("Sync")) return own;
        if (
          BUN_TYPES.test(source) &&
          (own === "resolveSync" || own === "scanSync")
        )
          return own;
        if (source.includes(TIMED_FS) && own === "scanGlobSync") return own;
      }
      return undefined;
    };

    return {
      CallExpression(node) {
        const name = blocking(node);
        if (name !== undefined)
          context.report({
            node: node.callee,
            messageId: "sync",
            data: { name },
          });
      },
    };
  },
});
