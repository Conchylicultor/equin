import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  buildModuleGraph,
  currentRecordStore,
  repoModuleOf,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  describeWideKeys,
  keyWidths,
  MAX_UNUSED_KEY_MODULES,
} from "@plugins/plugin-meta/plugins/plugin-records/plugins/key-width/core";
import {
  facetExtractionHarness,
  facetRecordProducers,
  facetRecordsModule,
} from "../core";

/**
 * A facet record is keyed by its facet's module and the extraction harness,
 * each over its whole closure: a facet importing one helper from a heavy
 * barrel re-extracts every plugin on every edit to that barrel's closure, and
 * the harness's key is in every facet record of every plugin.
 */
const keyWidth: Check = {
  id: "faceted:facet-key-width",
  description: `every facet module and the facet extraction harness are keyed by at most ${MAX_UNUSED_KEY_MODULES} modules they never call`,
  async run(ctx: CheckContext): Promise<CheckResult> {
    const repo = await ctx.repo();
    const failure = describeWideKeys(
      await keyWidths(
        {
          snapshot: repo,
          store: currentRecordStore(),
          readOutside: () => null,
        },
        await facetRecordProducers(repo),
      ),
    );
    return failure === null ? { ok: true } : { ok: false, message: failure };
  },
};

/**
 * The record plumbing — keys, the store, the module graph, worker scheduling
 * (the `plugin-records` plugin) and the module that drives it
 * (`facet-records.ts`) — cannot change a facet's value, yet anything the
 * harness loads keys every facet record of every plugin. The key-width check
 * cannot see it: the harness would CALL that code (to define its job, to
 * key), so it is not unused. Whatever the harness needs from it is done by
 * `facet-records.ts`.
 */
const RECORDS_BARREL = "@plugins/plugin-meta/plugins/plugin-records/core";

const harnessPlumbing: Check = {
  id: "faceted:harness-no-record-plumbing",
  description:
    "the facet extraction harness (keyed into every facet record) loads no record key/store/worker code",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const repo = await ctx.repo();
    const harness = facetExtractionHarness(repo);
    const recordsBarrel = repoModuleOf(
      repo,
      import.meta.resolve(RECORDS_BARREL),
    );
    // The plugin-records plugin's folder: the barrel's, two levels up.
    const recordsDir = recordsBarrel.split("/").slice(0, -2).join("/") + "/";
    const plumbing = (m: string): boolean =>
      m.startsWith(recordsDir) || m === facetRecordsModule(repo);
    const graph = await buildModuleGraph(
      { snapshot: repo, store: currentRecordStore(), readOutside: () => null },
      [harness],
    );
    // The key's closure: static and dynamic imports alike.
    const seen = new Set<string>();
    const stack = [harness];
    while (stack.length > 0) {
      const m = stack.pop()!;
      if (seen.has(m)) continue;
      seen.add(m);
      const node = graph.modules.get(m);
      if (node) stack.push(...node.staticDeps, ...node.dynamicDeps);
    }
    const bad = [...seen].filter(plumbing).sort();
    if (bad.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${harness} is keyed into every facet record, yet loads record plumbing that cannot shape a value — move the call into ${facetRecordsModule(repo)}:\n${bad.map((m) => `  ${m}`).join("\n")}`,
    };
  },
};

export default [keyWidth, harnessPlumbing];
