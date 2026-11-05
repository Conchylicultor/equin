/**
 * no-process-crash-listener
 *
 * The process's crash listeners — `uncaughtException`,
 * `uncaughtExceptionMonitor`, `unhandledRejection` — are installed by the
 * framework at each process entry point (`installProcessCrashListeners`,
 * `core/process-crash-listeners.ts`), and a plugin handles a crash through
 * `processCrashSink` in its `sinkHandlers`. A listener a plugin installs itself
 * runs only where the code installing it runs: the reports engine installed its
 * crash hooks in `onReady`, which an exec child (a supervised job's body) skips,
 * so a child's uncaught throw was filed nowhere.
 *
 * Reported on `process.on` / `once` / `addListener` / `prependListener` /
 * `prependOnceListener` naming one of those events as a string literal, and on
 * `process.setUncaughtExceptionCaptureCallback`. Removing a listener is not
 * reported. Self-contained by necessity — the ESLint config loads rule files
 * through jiti, which cannot resolve `@plugins/*`.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

const CRASH_EVENTS = new Set([
  "uncaughtException",
  "uncaughtExceptionMonitor",
  "unhandledRejection",
]);

const ADD_LISTENER = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);

/** `process.<name>` (or `globalThis.process.<name>`), with `<name>`'s spelling. */
function processMethod(callee: TSESTree.Node): string | undefined {
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  if (callee.property.type !== "Identifier") return undefined;
  const object = callee.object;
  const isProcess =
    (object.type === "Identifier" && object.name === "process") ||
    (object.type === "MemberExpression" &&
      !object.computed &&
      object.object.type === "Identifier" &&
      object.object.name === "globalThis" &&
      object.property.type === "Identifier" &&
      object.property.name === "process");
  return isProcess ? callee.property.name : undefined;
}

export default createRule({
  name: "no-process-crash-listener",
  meta: {
    type: "problem",
    docs: {
      description:
        "A process crash listener (uncaughtException / unhandledRejection) is installed only by the framework at each process entry point; a plugin handles crashes through processCrashSink in its sinkHandlers.",
    },
    schema: [],
    messages: {
      listener:
        "Do not install a `{{event}}` listener: the framework installs the process's crash listeners at every process entry point (serve, exec) and dispatches each crash to `processCrashSink` — handle it with `sinkHandlers: [sinkHandler(processCrashSink, () => handler)]` (@plugins/framework/plugins/server-core/core). A listener installed from plugin code runs only where that code runs (an exec child skips `onReady`).",
      captureCallback:
        "Do not set the uncaught-exception capture callback: the framework owns the process's crash handling (`processCrashSink`, @plugins/framework/plugins/server-core/core).",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const method = processMethod(node.callee);
        if (method === undefined) return;
        if (method === "setUncaughtExceptionCaptureCallback") {
          context.report({ node, messageId: "captureCallback" });
          return;
        }
        if (!ADD_LISTENER.has(method)) return;
        const first = node.arguments[0];
        if (
          first?.type !== "Literal" ||
          typeof first.value !== "string" ||
          !CRASH_EVENTS.has(first.value)
        )
          return;
        context.report({
          node,
          messageId: "listener",
          data: { event: first.value },
        });
      },
    };
  },
});
