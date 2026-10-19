import { join, relative } from "path";
import type {
  Check,
  CheckContext,
} from "@plugins/framework/plugins/tooling/core";
import {
  discoverCollectedDirsIn,
  renderCollectedDirRegistry,
  collectedDirRegistryPath,
  committedRegistryBundle,
  collectEntriesWithDeps,
  buildRegistryGenContext,
  discoverBrowserHosts,
  formatGenerated,
  renderBrowserHost,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";

// Every `id: "<plugin.id>"` a rendered registry carries. The generator emits
// `id: ${JSON.stringify(e.id)}` one entry per line, and plugin ids contain no
// quotes or backslashes, so reading them back is exact. The `id: string;` line of
// the emitted `CollectedEntry` interface has no string literal after the colon
// and therefore cannot match.
function registryIds(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(/\bid: "([^"]+)"/g)) out.add(m[1]!);
  return out;
}

const check: Check = {
  id: "plugins-registry-in-sync",
  description:
    "All collected dir registries (web, server, central, check, lint, ...) are exactly what the `singularity` composition's closure renders from the current plugin source",
  async run(checkCtx: CheckContext) {
    // Everything this check enumerates or reads goes through the run's file
    // set — the collected dirs, every scanned source, the committed registries.
    const repo = await checkCtx.repo();
    const { root } = repo;
    const ctx = await buildRegistryGenContext(root, repo);
    const defs = await discoverCollectedDirsIn(repo);

    // ── Identity, not equivalence ────────────────────────────────────────────
    //
    // `singularity` is an ordinary entry in the compositions manifest, and its
    // resolved closure is HOW the committed registries are built:
    // `generatePluginRegistry` renders each `<dir>.generated.ts` with
    // `ctx.mainBundle` and nothing else. This check compares the committed bytes
    // against exactly that one render — the generator's own inputs, taken from
    // the same shared context, so there is nothing for the two to disagree about
    // beyond "was `./singularity build` run and committed".
    //
    // It used to assert something weaker, and now false: that filtering by main's
    // closure changed NOTHING (`render(bundle: mainBundle) === render(no
    // bundle)`). That was the right shape while `singularity.disabled` was the
    // mechanism that removed plugins and the closure merely had to agree with it.
    // Both halves of that are gone. The `base-exclusions` row carries a negative,
    // so main's closure is deliberately not every plugin; and an unfiltered
    // render has no spelling any more (`bundle` is a required parameter of
    // `renderCollectedDirRegistry`), because a registry belonging to no
    // composition is exactly how the app's membership and the manifest's used to
    // drift apart silently. "Main is a composition" stopped being a property
    // proved here and became the way main is built.
    for (const def of defs) {
      const file = collectedDirRegistryPath(def);
      const rel = relative(root, file);
      const actual = await repo.read(rel);
      if (actual === null) {
        return {
          ok: false,
          message: `${rel} is missing`,
          hint: "Run `./singularity build` to generate it.",
        };
      }
      const expected = await formatGenerated({
        file,
        content: await renderCollectedDirRegistry({
          ctx,
          def,
          // The same set `generatePluginRegistry` renders with: the
          // `singularity` composition's closure, or every plugin for a
          // `checkout`-membership dir.
          bundle: committedRegistryBundle(ctx, def),
          composition: ctx.main,
        }),
      });
      if (actual === expected) continue;

      // Name the ids, not the diff. "These two files differ" is useless to
      // whoever hits this: what they need is WHICH plugins the two sides disagree
      // about, in both directions — that list IS the repair instruction. Carried
      // but not rendered means the committed file ships a plugin main's closure
      // no longer reaches (a negative now trims it, or its edges went missing);
      // rendered but not carried means the closure reaches a plugin the committed
      // file never got. Both usually mean the same thing — the build was not run
      // — but which ids moved is what says whether that is the whole story.
      const { entries } = await collectEntriesWithDeps(
        ctx,
        def.dir,
        committedRegistryBundle(ctx, def),
      );
      const rendered = new Set(entries.map((e) => e.id));
      const carried = registryIds(actual);
      const stale = [...carried].filter((id) => !rendered.has(id)).sort();
      const missing = [...rendered].filter((id) => !carried.has(id)).sort();

      const parts: string[] = [];
      if (stale.length > 0) {
        parts.push(
          `${stale.length} plugin(s) the committed file carries that the "${MAIN_COMPOSITION_ID}" composition's closure does not reach: ${stale.join(", ")}`,
        );
      }
      if (missing.length > 0) {
        parts.push(
          `${missing.length} plugin(s) the closure reaches that the committed file is missing: ${missing.join(", ")}`,
        );
      }
      const detail =
        parts.length > 0
          ? `:\n    ${parts.join("\n    ")}`
          : " — the same plugins on both sides, so what differs is their order, their `dependsOn` edges, or the file's formatting.";

      return {
        ok: false,
        message: `${rel} is out of sync with what the "${MAIN_COMPOSITION_ID}" composition renders${detail}`,
        hint: `Run \`./singularity build\` and commit the regenerated file. If a listed plugin is one you did NOT expect to move: the committed registries are exactly "${MAIN_COMPOSITION_ID}"'s closure, so a plugin leaves them by being negated out of a manifest — check the \`base-exclusions\` row (whose negatives every composition inherits) and "${MAIN_COMPOSITION_ID}"'s own entry points \`["**"]\` in plugins/plugin-meta/plugins/composition/core/config.ts.`,
      };
    }

    // A browser host's graph (`bin/browser-host.generated.ts`): the server
    // barrels its declared plugins load, rendered from the same source.
    for (const host of discoverBrowserHosts(repo)) {
      const actual = await repo.read(host.generated);
      const expected = await formatGenerated({
        file: join(root, host.generated),
        content: await renderBrowserHost(ctx, host),
      });
      if (actual === expected) continue;
      return {
        ok: false,
        message:
          actual === null
            ? `${host.generated} is missing`
            : `${host.generated} is out of sync with the server barrels ${host.declaration}'s plugins load`,
        hint: "Run `./singularity build` and commit the regenerated file.",
      };
    }
    return { ok: true };
  },
};

export default check;
