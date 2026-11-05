import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** The report-sink types whose one handler slot is `register(fn)`. */
const SINK_TYPES = new Set(["ReportSink", "RequestSink"]);

/** A file of a `web/` folder: the browser registers from a mount effect. */
const isWebFile = (filename: string): boolean =>
  filename.split(/[\\/]/).includes("web");

/**
 * no-direct-sink-register
 *
 * Outside the browser, a handler on a `ReportSink` / `RequestSink` is declared
 * in its plugin's `sinkHandlers` (`sinkHandler(sink, () => handler)`,
 * `framework/server-core`), which the framework attaches in the phase EVERY
 * boot mode runs. A `sink.register(fn)` called from a lifecycle hook runs only
 * where that hook does: `database/query-deadline` registered in `onReady`,
 * which an exec child (a supervised job's body) skips, so every deadline missed
 * in a child was held by the sink and dropped when the child exited.
 *
 * Type-aware: reported on a `.register(…)` call whose receiver's type is named
 * `ReportSink` or `RequestSink` (by name, so a look-alike would pass), in any
 * file outside a `web/` folder — where a collector registers from its mount
 * effect, the browser's own lifecycle.
 */
export default createRule({
  name: "no-direct-sink-register",
  meta: {
    type: "problem",
    docs: {
      description:
        "Outside the browser, a report/request sink's handler is a sinkHandlers entry (sinkHandler from framework/server-core), attached by the framework in every boot mode — never sink.register(fn) from a hook.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      direct:
        "Declare this handler in the plugin's `sinkHandlers: [sinkHandler(sink, () => handler)]` (from @plugins/framework/plugins/server-core/core) instead of calling `.register(…)`: the framework attaches it in every boot mode, while a hook may be skipped by one (an exec child skips `onReady`), leaving the sink to hold and drop what that process emits.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (isWebFile(context.filename)) return {};
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "register"
        )
          return;
        const type = checker.getNonNullableType(
          services.getTypeAtLocation(callee.object),
        );
        const name = (type.aliasSymbol ?? type.getSymbol())?.getName();
        if (name === undefined || !SINK_TYPES.has(name)) return;
        context.report({ node, messageId: "direct" });
      },
    };
  },
});
