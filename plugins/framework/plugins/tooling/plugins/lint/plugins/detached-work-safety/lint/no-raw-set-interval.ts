import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

// The runtime folders whose code runs in a backend or central process (and the
// shared code both import), plus the process entry points under `bin/`.
const SCOPED_SEGMENTS = ["/server/", "/central/", "/shared/", "/bin/"];

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

/** `setInterval(...)`, `globalThis.setInterval(...)`, `x.setInterval(...)`. */
function isSetInterval(call: TSESTree.CallExpression): boolean {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name === "setInterval";
  return (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "setInterval"
  );
}

export default createRule({
  name: "no-raw-set-interval",
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban raw `setInterval` in server, central, shared and bin code. A " +
        "periodic in-process loop is `defineTimer` " +
        "(`@plugins/infra/plugins/background/plugins/timer/{server,central}`): " +
        "it spans every tick, records its runs, surfaces a failing tick, and " +
        "lists the loop in Debug → Background activity — none of which a raw " +
        "interval does, whatever its callback wraps. Work on a schedule is a " +
        "`defineJob`; work on a change is a watcher / LISTEN / event. The few " +
        "sites that cannot use a timer (a Worker thread or child-process entry, " +
        "a process's own orphan guard, a primitive's per-instance timer) are " +
        "declared in the exempted plugin's `exempt/index.ts`, each with its reason.",
    },
    schema: [],
    messages: {
      rawSetInterval:
        "Raw `setInterval` is not allowed in server/central code. Declare the " +
        "loop with `defineTimer` (infra/background/timer) so it is tracked and " +
        "listed in Background activity — or, if it must run on a schedule, make " +
        "it a `defineJob`. An exception belongs in the exempted plugin's `exempt/index.ts`, with its reason.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = (context.filename ?? "").split("\\").join("/");
    if (!inScope(filename)) return {};
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (isSetInterval(node)) {
          context.report({ node, messageId: "rawSetInterval" });
        }
      },
    };
  },
});
