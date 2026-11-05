import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { importClosures } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import { computedLoads } from "@plugins/packages/plugins/source-digest/server";
import { backendEntries } from "./backend-entries";

const ID = "boot:closure-digestable";

/**
 * What a serving backend runs has to be a closure `sourceDigest` can read:
 * a deploy may skip restarting a backend whose code did not change only when
 * "its code" is measurable, and one `import(x)` / `require(x)` whose path is
 * computed makes the whole closure unmeasurable — the digest cannot follow
 * it, so it refuses (`packages/source-digest`).
 *
 * Measured 2026-11-05: main's backend (5,958 repo modules) reached 24 such
 * files, every one of them build tooling (the check runner, codegen, lint,
 * web-artifacts, the facet loader) pulled in by a handful of server barrels,
 * plus the bin's own registry selection — research/
 * 2026-11-05-global-backend-code-identity.md.
 *
 * Measured with literal dynamic imports FOLLOWED (a module loaded later is
 * still code this process runs, and the digest follows it). Each finding is
 * charged to the backend entry — the bin, or one registry barrel — whose own
 * subgraph reaches it, the walk stopping at every other entry (they answer
 * for themselves), so the plugin that owns the edge is the one that fixes it
 * or exempts it. An exemption covers the entry's whole subgraph, so a new
 * computed load reached ONLY through an exempted entry passes until that
 * entry's debt is paid; every other entry stays held to zero. Uses the
 * digest's own reading of a module
 * (`computedLoads`), so the guard and the digest cannot disagree.
 */
const check: Check = {
  id: ID,
  description:
    "the serving backend's closure (its bin plus every server/machine registry barrel, literal dynamic imports followed) holds no dynamic import or require with a computed path — so sourceDigest can measure the code a backend runs",
  exemptable: {
    [ID]: "this backend entry reaches a module that loads code by a computed path, so the code a backend runs cannot be digested",
  },
  outOfScope: ["test"],
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const found = await backendEntries(repo);
    if (!found.ok) return found.result;
    const { entries } = found;
    const closure = await importClosures(repo.root, entries, {
      dynamicImports: "follow-except-command-runs",
    });

    // Every module of the closure the digest would refuse.
    const computed = new Map<string, number>();
    await Promise.all(
      [...closure.modules].map(async (m) => {
        const text = await repo.read(m);
        if (text === null) return;
        const loads = computedLoads(m, text);
        const n = loads.import + loads.require;
        if (n > 0) computed.set(m, n);
      }),
    );
    if (computed.size === 0) return { ok: true };

    const entrySet = new Set(entries);
    const exempt = await ctx.exempt(ID);
    const findings: string[] = [];
    for (const entry of entries) {
      const reached: string[] = [];
      const seen = new Set([entry]);
      const stack = [entry];
      while (stack.length > 0) {
        const m = stack.pop()!;
        if (computed.has(m)) reached.push(m);
        for (const child of closure.children(m)) {
          if (seen.has(child) || entrySet.has(child)) continue;
          seen.add(child);
          stack.push(child);
        }
      }
      if (reached.length === 0 || exempt.skips(entry)) continue;
      reached.sort();
      findings.push(
        `${entry} reaches ${reached.length} module(s):\n      ` +
          reached.map((m) => `${m} (${computed.get(m)})`).join("\n      "),
      );
    }
    if (findings.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        `the backend's closure (${closure.modules.size} modules) loads code by a computed path, so the code a backend runs cannot be digested:\n  ` +
        findings.join("\n  "),
      hint:
        "Build tooling does not run in the serving process: run it out of process (a supervised job's `argv` body, a CLI command) and read its result as data. " +
        "Code the backend does run loads by a literal path: a string-literal specifier, or a generated registry of literal loaders.",
    };
  },
};

export default check;
