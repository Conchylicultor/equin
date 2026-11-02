import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";
import {
  FS_MODULE,
  PATH_PARAM_TYPE,
  STRING_PATH_PARAMS,
  inRuntime,
  provenance,
  type Node,
} from "./provenance";

const createRule = lintRuleCreator(import.meta.url);

/**
 * no-sync-fs
 *
 * A synchronous fs call on the backend's JS thread takes only a path PROVEN
 * app-owned. A path the user (or their config) chose may sit in a folder macOS
 * gates behind Files & Folders (Downloads, Documents, Desktop, removable and
 * network volumes); while the "allow access?" prompt is up, a `realpathSync`
 * / `readdirSync` / `statSync` / `opendirSync` / … on it blocks the whole JS
 * thread until someone answers. On 2026-10-11 one `realpathSync` of
 * `~/Downloads` froze main for 5.5 h
 * (research/2026-10-30-apps-sonata-midi-folder-probe-off-the-js-thread.md).
 *
 * The check is an allow-list, not a deny-list: an unmarked `string` is NOT
 * proven, so a user path arriving as a plain string (an endpoint body, a
 * config field, a watcher event) can never reach a sync call — nobody has to
 * remember to mark it (research/2026-10-31-global-sync-fs-app-path.md).
 *
 * Proof is carried by the TYPE, so it crosses files without this rule reading
 * any file but the one it lints (a type-aware rule may read declarations
 * only — research/2026-10-17-global-lint-keyed-on-what-it-reads.md). An
 * expression is app-owned when:
 *
 * - its type carries the `AppPath` brand (a data dir, the repo root, a
 *   parameter or return declared `AppPath`), or
 * - it is a non-empty string literal, `import.meta.dir` / `.path` / … ,
 *   `__dirname`, `process.execPath`, `process.cwd()`, `tmpdir()`,
 *   `fileURLToPath(…)` (a module URL), `mkdtemp(Sync)(…)`, or
 * - it is rooted in one: `join` / `normalize` / `dirname` of an app-owned
 *   first argument, `resolve` of app-owned arguments only, a template or `+`
 *   whose head is (a literal head, or an app-owned leading expression),
 *   `realpath` / `readlink` of one, a branch both arms of which are, an
 *   `await` or a cast of one — or a `const` of the file bound to one.
 *
 * Nothing user-chosen (`UserPath`) is ever app-owned, whatever it is built
 * into.
 *
 * Reported in runtime code (`server/`, `machine/`, `central/`, `core/`,
 * `shared/`):
 *
 * - **user** — a user-chosen path reaches a `node:fs` `*Sync` call;
 * - **unproven** — any other path that is not proven app-owned does.
 *
 * Typing a path `AppPath` without a proof is `no-unproven-claim`'s.
 */
export default createRule({
  name: "no-sync-fs",
  meta: {
    type: "problem",
    docs: {
      description:
        "A synchronous fs call on a backend's JS thread takes only a path proven app-owned (AppPath): a pending macOS Files & Folders prompt blocks a sync call on a user-chosen path — and the thread — until someone answers.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      user: "`{{name}}` on a user-chosen path blocks the backend's JS thread while macOS asks whether equin may open its folder (5.5 h on 2026-10-11). Use the async `node:fs/promises` call, bounded so a caller never waits on the prompt: a probe still unanswered after a bound reads as a `checking` state (Sonata's midi folders: `createFolderStatusStore`), and host-fs is the async read API.",
      unproven:
        "`{{name}}` takes a path not proven app-owned — it may be one the user chose, and a sync fs call on a path in a folder macOS gates (Downloads, Documents, a volume…) blocks the backend's JS thread until its permission prompt is answered (5.5 h on 2026-10-11). Type the path `AppPath` where the app makes it (`@plugins/infra/plugins/host-fs/plugins/user-path/core`; data dirs and the paths module already answer one) so the proof follows it here, or use the async `node:fs/promises` call.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!inRuntime(context)) return {};
    const { calleeDeclaration, declaredIn, typeOf, user, app } = provenance(
      ESLintUtils.getParserServices(context),
    );

    /**
     * The `node:fs` `*Sync` function a call invokes, if it does, and which of
     * its arguments name a path.
     */
    const syncFs = (
      call: TSESTree.CallExpression,
    ): { name: string; paths: Node[] } | undefined => {
      const decl = calleeDeclaration(call);
      if (decl === undefined || !declaredIn(decl, FS_MODULE)) return undefined;
      // The function itself, or the namespace it hangs off:
      // `realpathSync.native` is `native` inside `namespace realpathSync`.
      let name: string | undefined;
      for (let n: ts.Node | undefined = decl; n !== undefined; n = n.parent) {
        const own = (n as ts.FunctionDeclaration).name?.getText();
        if (own?.endsWith("Sync") === true) {
          name = own;
          break;
        }
        if (ts.isSourceFile(n)) break;
      }
      if (name === undefined) return undefined;
      const fn = name;
      const params = (decl as ts.SignatureDeclaration).parameters;
      const paths = call.arguments.filter((arg, i) => {
        // A link's target is the text it holds, never opened by the call.
        if (fn === "symlinkSync" && i === 0) return false;
        const type = params[i]?.type?.getText();
        const named = STRING_PATH_PARAMS[fn]?.includes(i) === true;
        if (!named && (type === undefined || !PATH_PARAM_TYPE.test(type)))
          return false;
        // A descriptor (`fstatSync(fd)`) is no path.
        return !(typeOf(arg).flags & ts.TypeFlags.NumberLike);
      });
      return { name, paths };
    };

    return {
      CallExpression(node) {
        const sync = syncFs(node);
        if (sync === undefined) return;
        for (const path of sync.paths) {
          if (user(path))
            context.report({
              node: path,
              messageId: "user",
              data: { name: sync.name },
            });
          else if (!app(path))
            context.report({
              node: path,
              messageId: "unproven",
              data: { name: sync.name },
            });
        }
      },
    };
  },
});
