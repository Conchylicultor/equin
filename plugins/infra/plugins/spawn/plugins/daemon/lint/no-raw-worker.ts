import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

// Backend code: a worktree server, central, and what they share. A CLI command
// or a check's worker thread ends with its command — it is not something the
// backend keeps running.
const SCOPED_SEGMENTS = ["/server/", "/central/", "/shared/"];

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

/** `Worker`, `globalThis.Worker`, `globalThis["Worker"]`. */
function isWorkerCallee(node: TSESTree.Expression): boolean {
  if (node.type === "Identifier") return node.name === "Worker";
  if (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    (node.object.name === "globalThis" || node.object.name === "self")
  ) {
    if (!node.computed && node.property.type === "Identifier") {
      return node.property.name === "Worker";
    }
    return (
      node.computed &&
      node.property.type === "Literal" &&
      node.property.value === "Worker"
    );
  }
  return false;
}

export default createRule({
  name: "no-raw-worker",
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban `new Worker(...)` in server, central and shared code. A worker " +
        "thread a backend keeps running is declared with `defineDaemon` " +
        "(`@plugins/infra/plugins/spawn/plugins/daemon/server`) and started with " +
        "`spawnWorker` — named, described, supervised (respawn with backoff, " +
        "give-up on repeated rapid exits) and listed under Long-lived processes " +
        "in Debug → Background activity.",
    },
    schema: [],
    messages: {
      rawWorker:
        "Raw `new Worker(...)` is not allowed in server/central/shared code. " +
        "Declare it with `defineDaemon` (infra/spawn/daemon/server) and start " +
        "it with `spawnWorker`, so it is supervised and listed in Background " +
        "activity. An exception belongs in the exempted plugin's `exempt/index.ts`, with its reason.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = (context.filename ?? "").split("\\").join("/");
    if (!inScope(filename)) return {};
    return {
      NewExpression(node) {
        if (isWorkerCallee(node.callee)) {
          context.report({ node, messageId: "rawWorker" });
        }
      },
    };
  },
});
