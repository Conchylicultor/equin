import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { relative } from "node:path";
import { isE2eScriptPath } from "../core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Bans Playwright's `"networkidle"` in e2e scripts. It never fires on this app:
 * the live sockets run in a SharedWorker, whose script load Playwright reports
 * as a page request but never sees finish (the response lands in the worker's
 * target), so a wait on it times out every time. `waitForNetworkIdle` (and
 * `boot()` without a marker) count requests themselves and leave that load out.
 *
 * Scoped to e2e scripts: server-side Playwright renderers of OTHER pages
 * (prototype thumbnails, browser-fetch) legitimately use it.
 */
export default createRule({
  name: "no-networkidle",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Playwright's `networkidle` in e2e scripts — it never fires on this app.",
    },
    schema: [],
    messages: {
      networkidle:
        "Playwright's `networkidle` never fires on this app: the live sockets " +
        "run in a SharedWorker, whose script load Playwright never sees finish, " +
        "so this wait times out every time. Use `waitForNetworkIdle(page)` (or " +
        "`boot()` without a marker) from " +
        "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!isE2eScriptPath(relative(context.cwd, context.filename))) return {};
    return {
      Literal(node) {
        if (node.value === "networkidle") {
          context.report({ node, messageId: "networkidle" });
        }
      },
    };
  },
});
