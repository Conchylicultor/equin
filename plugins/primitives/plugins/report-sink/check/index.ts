import type TS from "typescript";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
import {
  listCandidateSources,
  parsedTsSource,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";

/** The factories whose first argument is the sink's id. */
const SINK_FACTORIES = new Set(["defineReportSink", "defineRequestSink"]);

let tsPromise: Promise<typeof TS> | undefined;
function loadTs(): Promise<typeof TS> {
  return (tsPromise ??= import("typescript").then((m) => m.default));
}

/** Every literal id `src` passes to a sink factory, with its line. */
async function sinkIdsIn(
  rel: string,
  src: string,
): Promise<{ id: string; line: number }[]> {
  const ts = await loadTs();
  const sf = await parsedTsSource(ts, { rel, src });
  const ids: { id: string; line: number }[] = [];
  const visit = (n: TS.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      SINK_FACTORIES.has(n.expression.text)
    ) {
      const arg = n.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        const line = sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line;
        ids.push({ id: arg.text, line: line + 1 });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return ids;
}

/**
 * A sink's id keys its handler in the build's table
 * (`server-core/core/contributors.generated.ts`, as `sink:<id>`), so two sinks
 * sharing one would merge there: a job process would start the handler of a
 * sink it never declared. The `report-sink/sink-id-matches-declaration` lint
 * pins each id to `<plugin path>:<binding>`, but the same binding in two files
 * of one plugin still collides — a whole-repo fact no per-file lint sees.
 * Test code is out of scope: its throwaway sinks never reach the table.
 */
const uniqueSinkIds: Check = {
  id: "report-sink:unique-sink-ids",
  // INPUT-KEYED: a pure function of the `git grep -l` selections and their
  // candidates' content — all recorded.
  inputKeyed: true,
  description:
    "no two report / request sinks share an id (`defineReportSink(id)`, `defineRequestSink(id)`) — it keys the sink's handler in the build's contributors table",
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const sites = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const factory of SINK_FACTORIES) {
      for (const { rel, src } of await listCandidateSources({
        root: repo.root,
        grepArg: factory,
        fixed: true,
      })) {
        if (seen.has(rel) || isTestCodePath(rel.split("/"))) continue;
        seen.add(rel);
        for (const { id, line } of await sinkIdsIn(rel, src)) {
          sites.set(id, [...(sites.get(id) ?? []), `${rel}:${line}`]);
        }
      }
    }
    if (sites.size === 0) {
      return {
        ok: false,
        message:
          'No sink declaration found (`defineReportSink("…")` / `defineRequestSink("…")`), so no id could be checked. The repo declares dozens, so this is a scan failure, not a clean pass.',
      };
    }
    const dups = [...sites].filter(([, at]) => at.length > 1);
    if (dups.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${dups.length} sink id(s) declared more than once:\n    ${dups
        .map(([id, at]) => `${JSON.stringify(id)}: ${at.join(", ")}`)
        .join("\n    ")}`,
      hint: "A sink's id is `<plugin path>:<binding>` of the const it initializes: rename one of the bindings (and its id — the `report-sink/sink-id-matches-declaration` lint autofixes it), so each sink keys its own handler in the build's contributors table.",
    };
  },
};

export default uniqueSinkIds;
