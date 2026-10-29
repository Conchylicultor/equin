import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

// Wrappers that self-attribute their body to a span (or deliberately opt out of
// the profiler). A `void <call>` to one of these is fine — the cost lands on a
// named span (`runTracked` / `recordEntrySpan`: a `bg`/entry span; `captureTrace`
// / `recordReport`: wrap their own DB writes in runInBackgroundLane +
// runWithoutProfiling; `enqueue`: the jobs worker opens a `job` span per run;
// `runWithoutProfiling` / `runInBackgroundLane`: observability-internal opt-outs).
const ALLOWED_ESCAPES = new Set([
  "runTracked",
  "runWithoutProfiling",
  "runInBackgroundLane",
  "recordEntrySpan",
  "captureTrace",
  "recordReport",
  "enqueue",
]);

/**
 * Off-main-thread entry points: code that runs on a Bun `Worker` thread or in a
 * spawned child process, NOT on the backend's main event loop. The
 * runtime-profiler is installed only on main, so `runTracked` there is a no-op —
 * and for subprocess probes it is outright forbidden (importing the plugin
 * runtime would pull the whole plugin graph into the measured process's heap and
 * destroy the footprint measurement it exists to take). So detached work in these
 * files has no span to attribute to and the rule does not apply.
 *
 * Two greppable, self-documenting conventions — extend this predicate as new
 * off-main entries are added, rather than adding per-line disables:
 *   • a `/worker/` path segment — a Bun Worker-thread subtree (e.g. the sentinel
 *     sampler/latch worker; the whole directory runs off-main).
 *   • an `entry.ts` basename — the spawned worker / child-process entry-point
 *     convention (the sentinel worker, the paging-probe child process).
 * The on-main *supervisor* that spawns these (e.g. `worker-host.ts` /
 * `probe-host.ts`) is NOT exempt — it runs on main and stays subject to the rule.
 */
function isOffMainThreadEntry(filename: string): boolean {
  return filename.includes("/worker/") || filename.endsWith("/entry.ts");
}

/** The callee's simple name: `foo` from `foo()`, `foo` from `obj.foo()`. */
function calleeName(call: TSESTree.CallExpression): string | undefined {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return undefined;
}

export default createRule({
  name: "no-untracked-detached-work",
  meta: {
    type: "problem",
    docs: {
      description:
        "Route detached main-thread work (a `void <call>` fire-and-forget) " +
        "through `runTracked(label, fn)` so its cost is " +
        "attributed to a span instead of silently inflating an unrelated span's " +
        "selfMs (or vanishing at boot). Server/central only. A `setInterval` is " +
        "the sibling rule `no-raw-set-interval`'s (banned outright). `setTimeout` is " +
        "deliberately NOT flagged: debounce / backoff / one-shot uses dominate it, " +
        "it is rarely the invisible-long-work class, and the file-watcher substrate " +
        "already spans its timers. Off-main-thread entry files (a `/worker/` " +
        "subtree or an `entry.ts` spawned worker/subprocess entry point) are also " +
        "skipped: the runtime-profiler is not installed on a Worker thread or child " +
        "process (and is forbidden in the subprocess probes), so there is no span to " +
        "attribute to. Their on-main supervisor (`*-host.ts`) stays in scope.",
    },
    schema: [],
    messages: {
      untrackedDetachedWork:
        "Detached main-thread work must be routed through `runTracked(label, fn)` " +
        "(`@plugins/infra/plugins/runtime-profiler/core`) so its cost is attributed " +
        "to a span instead of silently inflating an unrelated span's selfMs (or " +
        "vanishing at boot). Explicit escapes: `runWithoutProfiling` / " +
        "`runInBackgroundLane` (observability-internal), or a job `enqueue`. A " +
        "sanctioned system-measuring sampler should carry an eslint-disable with a " +
        "reason.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = (context.filename ?? context.getFilename?.() ?? "")
      .split("\\")
      .join("/");

    // Scope: this concerns main-thread server/central work only. Skip tests, and
    // client / isomorphic / separate-process trees (a different concern).
    if (filename.endsWith(".test.ts") || filename.endsWith(".spec.ts"))
      return {};
    if (
      filename.includes("/web/") ||
      filename.includes("/core/") ||
      filename.includes("/shared/") ||
      filename.includes("/bin/")
    ) {
      return {};
    }
    if (!filename.includes("/server/") && !filename.includes("/central/")) {
      return {};
    }
    // ...but code that runs off the backend main thread (a Worker thread or a
    // spawned child process) has no main-thread profiler to attribute to — see
    // `isOffMainThreadEntry`.
    if (isOffMainThreadEntry(filename)) return {};

    return {
      // Trigger 1 — `void <Call>`. Only DIRECT calls (`void foo()`,
      // `void obj.foo()`, `void (async()=>{})()`) — deliberately NOT
      // `void someIdentifier` (a bare promise variable awaited/stored elsewhere).
      'UnaryExpression[operator="void"]'(node: TSESTree.UnaryExpression) {
        if (node.argument.type !== "CallExpression") return;
        const name = calleeName(node.argument);
        if (name !== undefined && ALLOWED_ESCAPES.has(name)) return;
        context.report({ node, messageId: "untrackedDetachedWork" });
      },
    };
  },
});
