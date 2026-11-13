import type { TSESTree } from "@typescript-eslint/utils";
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The resident-size readings a process has — `resourceUsage().maxRSS` (getrusage's
 * peak) and `memoryUsage().rss` — over-count what it costs: on macOS they keep
 * counting allocator pages it already freed (MADV_FREE-reusable) and shared
 * library text, which the kernel charges against no one. A type-check worker
 * read 1.8 GB maxRSS for a 1.15 GB physical footprint; a Bun backend's rss is
 * ~6x its footprint. So neither has a spelling: memory is read through
 * `packages/proc-rusage` (a process's footprint and lifetime peak) or a
 * spawn's `peakFootprint`.
 */
export default createRule({
  name: "no-rss-memory",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading a process's memory as resident size (maxRSS / memoryUsage().rss) — read its physical footprint.",
    },
    schema: [],
    messages: {
      rss:
        "A resident size over-counts what a process costs: on macOS it keeps counting " +
        "allocator pages the process already freed and shared library text (a type-check " +
        "worker: 1.8 GB maxRSS for a 1.15 GB footprint; a Bun backend's rss is ~6x its " +
        "footprint), and `process.resourceUsage().maxRSS` is in KiB besides. Read the " +
        "physical footprint instead: `readProcRusage(pid)` from " +
        "@plugins/packages/plugins/proc-rusage/core (`memory.physFootprintBytes`, and " +
        "`memory.peakPhysFootprintBytes` for the lifetime peak), `procMemory()` / " +
        "`peerProcUsage()` from server-core, or a child's `resourceUsage.peakFootprint` " +
        '(spawn with `peakFootprint: "report"`). A host with no footprint at all is the ' +
        "one sanctioned fallback, declared in the plugin's exempt/index.ts.",
    },
  },
  defaultOptions: [],
  create(context) {
    const name = (node: TSESTree.MemberExpression): string | null =>
      !node.computed && node.property.type === "Identifier"
        ? node.property.name
        : node.computed &&
            node.property.type === "Literal" &&
            typeof node.property.value === "string"
          ? node.property.value
          : null;
    const isMemoryUsageCall = (node: TSESTree.Node): boolean =>
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      name(node.callee) === "memoryUsage";
    return {
      MemberExpression(node) {
        const prop = name(node);
        // `x.resourceUsage().maxRSS`, `usage.maxRSS`, `usage?.maxRSS`: the
        // property is getrusage's and nobody else's.
        if (prop === "maxRSS") context.report({ node, messageId: "rss" });
        else if (prop === "rss" && isMemoryUsageCall(node.object))
          context.report({ node, messageId: "rss" });
      },
      // `const { rss } = process.memoryUsage()` / `{ maxRSS } = …resourceUsage()`.
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || node.init === null) return;
        for (const p of node.id.properties) {
          if (p.type !== "Property" || p.key.type !== "Identifier") continue;
          if (
            p.key.name === "maxRSS" ||
            (p.key.name === "rss" && isMemoryUsageCall(node.init))
          )
            context.report({ node: p, messageId: "rss" });
        }
      },
    };
  },
});
