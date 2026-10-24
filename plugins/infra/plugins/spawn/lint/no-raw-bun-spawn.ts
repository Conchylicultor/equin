import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

export default createRule({
  name: "no-raw-bun-spawn",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw Bun.spawn outside the infra/spawn plugin — piped child stdio " +
        "can permanently wedge the event loop (bun 1.3.13 exit-during-stream-pull race).",
    },
    schema: [],
    messages: {
      rawBunSpawn:
        "Raw Bun.spawn can permanently wedge the event loop: bun 1.3.13 (unfixed " +
        "through 1.4-canary) has a race where a child with piped stdio exiting during " +
        "a pending stream pull spins the native microtask queue at 100% CPU forever — " +
        "every field `./equin build/check/push` wedge is this bug (see " +
        "research/2026-07-22-global-spawn-plugin-wedge-mitigation.md). Even an " +
        'option-less Bun.spawn(argv) is exposed: stdout DEFAULTS to "pipe". Route ' +
        "through @plugins/infra/plugins/spawn/core instead — spawnCaptured / " +
        "spawnExpectOk (capture via temp-file fds; stdin as a whole buffer), " +
        "spawnPassthrough (inherit, with onSpawn for signal forwarding), and " +
        "getWorktreeRoot / getMainRepoRoot (the memoized git-root helpers). " +
        "A long-lived child or worker a backend keeps running is declared with " +
        "defineDaemon (@plugins/infra/plugins/spawn/plugins/daemon/server) — " +
        "supervised and listed in Debug → Background activity. " +
        "Bun.spawnSync buffers natively (no JS streams) and is not flagged. A " +
        "genuinely interactive/streaming child (rare — e.g. drizzle-kit's prompt " +
        "parser in migrations-interactive.ts) gets an `exempt/index.ts` entry in its own " +
        "plugin with a written justification, never an inline disable.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // Every `Bun.spawn` member access — calls, aliasing (`const s = Bun.spawn`),
      // and the computed form `Bun["spawn"]`. `spawnSync` deliberately unmatched.
      MemberExpression(node) {
        if (node.object.type !== "Identifier" || node.object.name !== "Bun")
          return;
        const prop =
          !node.computed && node.property.type === "Identifier"
            ? node.property.name
            : node.computed &&
                node.property.type === "Literal" &&
                typeof node.property.value === "string"
              ? node.property.value
              : null;
        if (prop === "spawn") {
          context.report({ node, messageId: "rawBunSpawn" });
        }
      },
    };
  },
});
