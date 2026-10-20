import { declareRuntimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLUGINS_DIR,
  REPO_ROOT,
  checkoutNamespace,
} from "@plugins/infra/plugins/paths/core";
import type { ServerContribution } from "@plugins/framework/plugins/server-core/core";

// `bun test` preload (registered in the root bunfig.toml `[test]` section).
//
// Worktree-scoped server code — the `db` pool, the per-worktree log dir,
// config_v2, reports — asks `runtimeNamespace()` which namespace this process
// serves. A real backend is told by the gateway (`--namespace <ns>`); a bare
// `bun test` is told by nobody, so any suite that transitively touches that code
// would throw the moment it ran.
//
// The default belongs HERE, not at each read site: those must stay loud in
// production (a backend with no identity is a real bug), but a test run's
// sensible identity is simply the checkout it runs from.
//
// `checkoutNamespace` MINTS the namespace — it asks git which root owns `.git`
// and applies the elision rule — rather than casting the checkout's directory
// basename. The two agree for every agent worktree and for main, which is
// exactly why the shortcut is tempting and exactly why it is banned
// (`namespace-identity/no-laundered-checkout-namespace`): they stop agreeing the
// moment a composition is served from a non-main checkout.
//
// That mint is async, hence the top-level await. A preload is an ES module, so
// the whole preload is awaited before the first test file is imported — which
// is the property that matters: no suite can observe an undeclared namespace.
declareRuntimeNamespace(await checkoutNamespace(REPO_ROOT));

// A test process is also a HOST that never boots its plugin graph: suites call
// code that reads host services (`db` reads the database driver, `job.enqueue`
// the job queue) with no `collectContributions` behind them. A `bun test` runs
// on the desktop, so its providers are the desktop's — the host-service
// providers among the app's machine halves (`machine.generated.ts`, the
// committed `singularity` composition). A suite that boots a graph of its own
// (the PGlite boot test) collects its own providers, which then answer instead.
//
// Only the machine halves that PROVIDE a host service are loaded (their barrel
// spells `<Service>.provide(`), one at a time in registry order: loading every
// machine half would evaluate most of the app's server graph in every test
// process, registering resources (and jobs, channels) no suite asked for — and
// a suite booting a slice of the graph would then find them undeclared. A
// provider this misses fails loudly at its first `get()` ("no provider").
//
// A process that boots a graph of its OWN (a portable boot test's child, which
// sets `BOOTS_OWN_PLUGIN_GRAPH=1`) gets none of them: its graph collects its own
// providers, and loading the desktop's would evaluate their server code — a
// provider's whole import closure (the transcript reader reaches reports and
// config) — into a process whose graph does not hold it.
if (process.env.BOOTS_OWN_PLUGIN_GRAPH !== "1") {
  const { machineEntries } =
    await import("../plugins/framework/plugins/server-core/core/machine.generated");
  const { provideHostServicesUnbooted } =
    await import("@plugins/framework/plugins/server-core/core");
  const providers: ServerContribution[] = [];
  for (const entry of machineEntries) {
    const barrel = join(PLUGINS_DIR, entry.pluginPath, "machine", "index.ts");
    if (!/\.provide\(/.test(readFileSync(barrel, "utf8"))) continue;
    const mod = (await entry.loader()) as {
      default: { contributions?: readonly ServerContribution[] };
    };
    providers.push(...(mod.default.contributions ?? []));
  }
  provideHostServicesUnbooted(providers);
}
