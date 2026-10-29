import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

/**
 * no-void-fetch-endpoint
 *
 * Flags `void fetchEndpoint(...)` — a discarded endpoint promise. The `void`
 * silences the floating-promise check but registers no `.catch`, so a non-2xx
 * response throws an `EndpointError` that escapes to `window.onunhandledrejection`:
 * recorded as a contextless `browser-rejection` crash, never surfaced to the user.
 *
 * The fix for user-triggered mutations is `useEndpointMutation`, which routes
 * the error through the global toast safety net (`crashes/mutation-errors`) for
 * free. `void fetchEndpoint()` is legitimate ONLY for genuine fire-and-forget —
 * where a failure is silent + self-correcting AND state refreshes via another
 * channel (live-state push, next interaction). Those sites declare intent
 * explicitly: a file-level glob in lint/index.ts (whole-file fire-and-forget) or
 * an inline `// eslint-disable-next-line endpoints/no-void-fetch-endpoint -- <why>`
 * for per-call exceptions. See the endpoints plugin CLAUDE.md.
 *
 * Detection is NAME-based (like no-raw-web-fetch): a `void` UnaryExpression whose
 * direct argument is a call to `fetchEndpoint`. A `.then()/.catch()` chain is NOT
 * flagged — the chain's outer call is the operand, and a `.catch` means errors
 * are already handled.
 */

const createRule = lintRuleCreator(import.meta.url);

export default createRule({
  name: "no-void-fetch-endpoint",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `void fetchEndpoint(...)` — the discarded rejection escapes to " +
        "window.onunhandledrejection instead of the global error toast. Use " +
        "useEndpointMutation for user-triggered mutations.",
    },
    schema: [],
    messages: {
      noVoidFetchEndpoint:
        "`void fetchEndpoint(...)` discards the promise: a non-2xx response " +
        "throws an unhandled rejection that surfaces only as a contextless " +
        "browser-rejection crash, never a user-facing toast. Use " +
        "useEndpointMutation (global error toast for free) for user-triggered " +
        "mutations. For genuine fire-and-forget (silent, self-correcting, state " +
        "refreshes via another channel), opt out explicitly with an inline " +
        "// eslint-disable-next-line endpoints/no-void-fetch-endpoint -- <why>. " +
        "See the endpoints plugin CLAUDE.md.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      "UnaryExpression[operator='void']"(node: TSESTree.UnaryExpression) {
        const arg = node.argument;
        if (
          arg.type === "CallExpression" &&
          arg.callee.type === "Identifier" &&
          arg.callee.name === "fetchEndpoint"
        ) {
          context.report({ node, messageId: "noVoidFetchEndpoint" });
        }
      },
    };
  },
});
