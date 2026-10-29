import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Every `defineTimer(...)` call is reported unless the plugin owning its file
 * exempts it — with its reason — in its own `exempt/index.ts`. A timer is a periodic in-process
 * loop, which CLAUDE.md's "no polling" rule forbids by default: work on a
 * schedule is a `defineJob`, work on a change is a watcher / LISTEN / event.
 * Those exemptions are where each exception (central has no job queue; a watchdog
 * or sampler that must keep running while the queue is wedged) is argued once.
 */
export default createRule({
  name: "no-unlisted-timer",
  meta: {
    type: "problem",
    docs: {
      description:
        "`defineTimer` is allowed only in files their owning plugin exempts in " +
        "its `exempt/index.ts`, each with its reason — so a timer cannot become " +
        "a polling escape hatch.",
    },
    schema: [],
    messages: {
      unlistedTimer:
        "`defineTimer` is not a polling escape hatch. Work on a schedule is a " +
        "`defineJob` (cron); work on a change is a watcher / LISTEN / event. If " +
        "this loop truly must run in-process (central has no job queue; a " +
        "watchdog or sampler that must run while the queue is wedged), exempt " +
        "this file in your plugin's plugins/<you>/exempt/index.ts " +
        '(rule "timer/no-unlisted-timer", kind "sanctioned", with the reason).',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;
        const name =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" &&
                callee.property.type === "Identifier"
              ? callee.property.name
              : undefined;
        if (name === "defineTimer") {
          context.report({ node, messageId: "unlistedTimer" });
        }
      },
    };
  },
});
