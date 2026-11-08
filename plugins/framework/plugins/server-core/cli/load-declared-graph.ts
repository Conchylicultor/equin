import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { declareRuntimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { holdTreeRead } from "@plugins/infra/plugins/git/plugins/tree-lock/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { loadServerPlugins } from "../core/boot-stages";
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
  // The graph loads from the checkout's live tree, which a push's fast-forward
  // rewrites file by file — held so every module comes from one commit, as in
  // `runExec`.
  const treeRead = await holdTreeRead(REPO_ROOT);
  try {
    // Dynamic, like `runExec`'s: keeps a declaration that reaches this barrel
    // light (`cli:command-declarations-light` stops at dynamic edges).
    const { serverEntries, machineEntries } =
      await import("../bin/active-runtime");
    return await loadServerPlugins([...serverEntries, ...machineEntries]);
  } finally {
    treeRead.releaseSync();
  }
}
