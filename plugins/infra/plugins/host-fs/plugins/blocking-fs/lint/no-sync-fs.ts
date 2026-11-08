import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import {
  BACKEND_FOLDER,
  blockingAt,
  HELPER_FOLDER,
  isSyncReference,
  repoRelative,
  type Blocking,
} from "./blocking";

const createRule = lintRuleCreator(import.meta.url);

/**
 * no-sync-fs
 *
 * A backend's JS thread never waits on the disk or on a child process. A
 * synchronous fs call (`readFileSync`, `renameSync`, `openSync`, … — node's
 * own or timed-fs's twin, which carries node's declaration), a
 * `Bun.resolveSync` (it stats its way up the `node_modules` chain), a
 * synchronous glob scan or a synchronous child process (`spawnSync`,
 * `execSync`, `execFileSync`, `Bun.spawnSync`) holds the thread for as long
 * as the disk or the child takes to answer — on a busy host, seconds. Every
 * request, live read, job and timer of the process waits behind it, and every
 * other op in flight is recorded as slow
 * (research/2026-11-06-global-no-sync-fs-on-backends.md: 3–13.6 s stalls on
 * main, `renameSync ← writeAtomic`, `openSync ← readTail`, …).
 *
 * The same holds for a helper that does it on the backend's behalf: a
 * `core/`, `shared/` or `data-dirs/` function named `*Sync` — the name
 * `blocking-fs/sync-named` gives every helper there that blocks
 * (`openOwnedFdSync`, `readCheckoutDeploysSync`, …).
 *
 * Reported in `server/`, `machine/`, `central/` and `deps/` code (not tests,
 * `cli/`, `scripts/`, `bin/`, `provision/`), for a call or a function handed
 * on by reference. Use the async twin. A file that runs only where a blocked
 * thread harms nobody — before the backend listens, in its own child process,
 * in a synchronous `exit` handler — declares it: a `sanctioned` exemption in
 * its plugin's `exempt/index.ts`, with the reason.
 */
export default createRule({
  name: "no-sync-fs",
  meta: {
    type: "problem",
    docs: {
      description:
        "No synchronous fs call, sync child process or *Sync helper (node:fs / node:child_process *Sync, Bun.resolveSync / spawnSync, a sync glob scan, a core/shared/data-dirs *Sync) on a backend's JS thread: a slow disk or child turns its latency into a frozen process.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      fs: "`{{name}}` blocks the backend's JS thread until the disk answers — 3–13 s on a busy disk, every request and live read of the process frozen behind it. Use the async `node:fs/promises` twin (from timed-fs). Code that runs only before the backend listens, in its own child process or in a synchronous exit handler declares a `sanctioned` `blocking-fs/no-sync-fs` exemption in its plugin's exempt/index.ts.",
      process:
        "`{{name}}` blocks the backend's JS thread until the child exits — every request and live read of the process frozen behind it. Use the async spawn (`spawnCaptured` / `spawnExpectOk` from infra/spawn).",
      helper:
        "`{{name}}` blocks the backend's JS thread: a `*Sync` helper does sync fs or a sync child process on its caller's behalf (blocking-fs/sync-named). Call its async twin — add one beside it if it has none.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!BACKEND_FOLDER.test(repoRelative(context.filename, context.cwd)))
      return {};
    const services = ESLintUtils.getParserServices(context);

    const report = (node: TSESTree.Node, hit: Blocking | undefined) => {
      if (hit !== undefined)
        context.report({ node, messageId: hit.kind, data: { name: hit.name } });
    };

    const call = (node: TSESTree.CallExpression) =>
      report(node.callee, blockingAt(node, services, HELPER_FOLDER));
    const reference = (
      node: TSESTree.Identifier | TSESTree.MemberExpression,
    ) => {
      if (isSyncReference(node))
        report(node, blockingAt(node, services, HELPER_FOLDER));
    };

    return {
      CallExpression: call,
      Identifier: reference,
      MemberExpression: reference,
    };
  },
});
