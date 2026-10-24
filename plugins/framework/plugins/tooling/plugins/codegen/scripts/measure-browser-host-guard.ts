/**
 * Times the browser-host derivation the way its four callers pay for it,
 * without writing any generated file:
 *
 *   ./equin run plugins/framework/plugins/tooling/plugins/codegen/scripts/measure-browser-host-guard.ts
 *
 * Two passes, each over its own file set: one as build's codegen runs (one
 * ctx, `generateBrowserHosts`' inference then coverage guard), one as a check
 * pass runs (the three checks asking `buildRegistryGenContext` with the run's
 * set, in the order the derivation is most expensive for). Every ask after
 * the first per pass should be a memo hit; each line names the import-closure
 * builds its inference ran.
 */
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  buildRegistryGenContext,
  deriveBrowserHostGraph,
  discoverBrowserHosts,
  inferBrowserHostGraph,
} from "../core";

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const out = await run();
  console.log(
    `  ${label.padEnd(52)} ${(performance.now() - t).toFixed(0).padStart(6)} ms`,
  );
  return out;
}

const root = await getWorktreeRoot();

console.log("build codegen (regenerateRegistryCodegen's ctx):");
{
  const ctx = await timed("buildRegistryGenContext", () =>
    buildRegistryGenContext(root),
  );
  for (const host of discoverBrowserHosts(await ctx.repo())) {
    const graph = await timed(`${host.pluginPath}: inference`, () =>
      inferBrowserHostGraph(ctx, host),
    );
    console.log(`    (${graph.closures} import-closure builds)`);
    await timed(`${host.pluginPath}: coverage guard`, () =>
      deriveBrowserHostGraph(ctx, host),
    );
  }
}

console.log("check pass (the run's file set):");
{
  const repo = await loadRepoFiles(root);
  const ask = () => buildRegistryGenContext(root, repo);
  for (const host of discoverBrowserHosts(repo)) {
    await timed("plugins-registry-in-sync: derive", async () =>
      deriveBrowserHostGraph(await ask(), host),
    );
    await timed("browser-host:contributions-covered: infer", async () =>
      inferBrowserHostGraph(await ask(), host),
    );
    await timed("config-v2:registrations-paired: infer", async () =>
      inferBrowserHostGraph(await ask(), host),
    );
  }
}
