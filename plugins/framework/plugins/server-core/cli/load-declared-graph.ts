import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { declareRuntimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { pluginOfNode } from "@plugins/framework/plugins/plugin-id/core";
import { loadServerPlugins } from "../core/boot-stages";
import { installListEntries } from "../core/contributions";
import { graphNodeOf } from "../core/start-set";
import type { LoadedServerPlugin } from "../core/types";

// ── What a backend's graph DECLARES, without booting it ─────────────────────
//
// A server contribution is static data on a loaded plugin definition, so a
// question about the declared set — "which tables must a fork not copy?" — is a
// function of the code alone. Answering it used to need a RUNNING backend (one
// that had collected its contributions at boot), which made a recovery tool
// depend on the thing it recovers: `./equin db fork --replace` could not run
// while main's backend was down (2026-11-08, main crash-looping 18:06–18:34).
//
// This loads the graph `exec` would boot — the same registry
// (`../bin/active-runtime`, selected by the namespace's spec.json), the same
// load waves — and stops there. Nothing after the load runs: no
// `collectContributions` (process-global state a reader does not need — every
// kind reads a plain definition list with `Kind.from(plugins)`), no `register`,
// no `onReadyBlocking`, so no database is touched. That is what lets it answer
// when the database is the thing that cannot boot.
//
// `namespace` is declared first for the same reason `runExec` declares it:
// modules resolve namespace-scoped paths at module eval (`config_v2#machine`'s
// config dir), and it names which registry is selected. It is the namespace
// whose code is being read — the checkout's own (`checkoutNamespace`).

/**
 * Load the plugin graph `namespace` boots — every server and machine half —
 * and return its loaded definitions, topo-sorted. Read contributions off them
 * with `Kind.from(plugins)`; `Kind.getContributions()` throws here, since
 * nothing was collected.
 *
 * A module that fails to load throws (every failure named), as it fails a boot.
 */
export async function loadDeclaredGraph(
  namespace: Namespace,
): Promise<readonly LoadedServerPlugin[]> {
  declareRuntimeNamespace(namespace);
  // The graph loads from the checkout this process runs from, which no push
  // rewrites (a worktree; on main a slot this `./equin` holds for life —
  // `runExec` says why).
  const { serverEntries, machineEntries } =
    await import("../bin/active-runtime");
  return loadServerPlugins([...serverEntries, ...machineEntries]);
}

/**
 * Install the data lists' entries the build wrote down
 * (`core/list-entries.generated.ts`), kept to the registry `namespace` boots —
 * importing NO plugin. A data list (`defineServerContribution(name, { data:
 * true })`) then reads whole with `Kind.getContributions()`, the way every
 * booted host reads it: one path. For a process that only needs data lists
 * (`./equin db fork`'s probe).
 */
export async function installDeclaredListEntries(
  namespace: Namespace,
): Promise<void> {
  declareRuntimeNamespace(namespace);
  const { serverEntries, machineEntries } =
    await import("../bin/active-runtime");
  installListEntries(
    (await import("../core/list-entries.generated")).serverListEntries,
    new Map(
      [...serverEntries, ...machineEntries].map((e) => [
        graphNodeOf(e),
        pluginOfNode(e.id),
      ]),
    ),
  );
}
