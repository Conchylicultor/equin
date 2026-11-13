import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { fileSetImportClosures } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import { join } from "node:path";
import {
  closureRefusal,
  computedLoads,
} from "@plugins/packages/plugins/source-digest/server";
import { backendEntries, centralEntries } from "./backend-entries";

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
    "the serving backend's and central's closures (each bin plus every server/machine/central registry barrel, literal dynamic imports followed) hold no dynamic import or require with a computed path, and every import in them resolves as source-digest's walk answers it — so the code a backend or central runs is measurable (sourceDigest, restart-skip)",
  exemptable: {
    [ID]: "this backend entry reaches a module that loads code by a computed path, so the code a backend runs cannot be digested",
  },
  outOfScope: ["test"],
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    // Both processes a deploy restarts — and may skip restarting
    // (build/restart-skip) only while their code is measurable.
    const backend = await backendEntries(repo);
    if (!backend.ok) return backend.result;
    const central = await centralEntries(repo);
    if (!central.ok) return central.result;
    const entries = [...backend.entries, ...central.entries];
    // Read off the module graph: every module's imports (and which of its
    // `import()` edges are command runs) are file records, so a pass after
    // an edit scans the edited modules — never a `Bun.build` of the closure.
    const closure = await fileSetImportClosures(repo, entries, {
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
    if (computed.size === 0) return walkRefusal(repo.root, entries);

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
    // Every computed load is an exempted entry's declared debt: the closure
    // is unmeasurable by that debt (its task), so the walk would only repeat it.
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

/** The digest's own walk over the entries: whatever else it refuses. */
async function walkRefusal(
  root: string,
  entries: readonly string[],
): Promise<CheckResult> {
  const refusal = await closureRefusal(entries.map((e) => join(root, e)));
  if (refusal.ok) return { ok: true };
  return {
    ok: false,
    message: `the backend's closure is one source-digest's walk refuses, so the code a backend or central runs cannot be digested (restart-skip cannot judge a deploy): ${refusal.reason}`,
    hint: "Make the import resolvable the way the walk mirrors Bun (packages/source-digest/shared/resolve.ts) — a name only a page's import map answers belongs in framework/import-map-names — or keep the module out of what the server loads.",
  };
}

export default check;
