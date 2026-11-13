import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils } from "@typescript-eslint/utils";
import { declaringPlugin, pluginOfFile } from "./sink-owner";

const createRule = lintRuleCreator(import.meta.url);

/** The report-sink types whose one handler slot is `register(fn)`. */
const SINK_TYPES = new Set(["ReportSink", "RequestSink"]);

const isWebFile = (filename: string): boolean =>
  filename.split(/[\\/]/).includes("web");

/**
 * collect-through-companion
 *
 * In the browser, a handler on ANOTHER plugin's `ReportSink` / `RequestSink`
 * is a `ReportSinks.Collector({ from, collect: drain(sink, handler),
 * companion: true })` contribution (`primitives/report-sink/web`), never a
 * `sink.register(fn)` from a mount effect.
 *
 * Why: a collector imports its producer to reach the sink, and a composition
 * bundles a plugin with everything it imports. A collector mounted as a
 * `Core.Root` therefore carried its producer into every composition naming
 * it — the `reporters` pack put the page editor (Lexical, yjs: 32 modules,
 * ~141 KB br) into the public website's eager set through three editor-only
 * collectors. As a companion keyed by `from`, the collector ships only where
 * its producer already ships.
 *
 * Type-aware: reported on a `.register(…)` call in a `web/` file whose
 * receiver's type is named `ReportSink` or `RequestSink` and whose
 * declaration lies in another plugin than the file. A plugin registering on
 * its own sink is not collecting anything it does not already carry.
 */
export default createRule({
  name: "collect-through-companion",
  meta: {
    type: "problem",
    docs: {
      description:
        "In the browser, another plugin's report/request sink is collected through ReportSinks.Collector (a companion keyed by the producer), never sink.register(fn) — so the collector never carries its producer into a composition.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      direct:
        '`{{sink}}` is declared by plugin `{{owner}}`: collect it with `ReportSinks.Collector({ from: "{{owner}}", collect: drain({{sink}}, handler), companion: true })` in this plugin\'s web barrel (`ReportSinks` from @plugins/reports/plugins/collectors/web, `drain` from @plugins/primitives/plugins/report-sink/web) instead of calling `.register(…)`. A collector registering directly ships wherever it is named and carries `{{owner}}` with it; as a companion it ships only where `{{owner}}` does.',
    },
  },
  defaultOptions: [],
  create(context) {
    if (!isWebFile(context.filename)) return {};
    const self = pluginOfFile(context.filename);
    if (self === null) return {};
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
        const owner = declaringPlugin(services, callee.object);
        if (owner === null || owner === self) return;
        context.report({
          node,
          messageId: "direct",
          data: { sink: context.sourceCode.getText(callee.object), owner },
        });
      },
    };
  },
});
