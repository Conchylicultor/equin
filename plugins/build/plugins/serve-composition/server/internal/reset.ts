// Reset a served composition to its genuine first-launch state — a NARROWER
// `reapAttempt` (cf. debug/worktree-cleanup/server/internal/reap.ts). A served
// composition is live at http://<namespace>.localhost:9000 with its own DB and
// config dir, both named by that namespace. This keeps the spec + dist + code
// (so it stays served) and wipes ONLY that one namespace's DB + config back to
// exactly what a serve build provisions on a fresh serve, then restarts the
// backend — so the author sees the real new-user experience.
//
// EVERYTHING here is scoped to THIS BACKEND'S CHECKOUT, and has to be: a
// composition is served from whichever checkout built it, so the id `sonata`
// names `sonata` from main and `sonata.att-x` from a worktree — two namespaces,
// two databases, two config dirs. `REPO_ROOT` is the checkout this backend runs
// out of, so `namespaceFor(id, checkoutRef(REPO_ROOT))` is the one this surface
// is talking about, and the git layer the config is re-propagated from is the
// same tree that composed it.
//
// Why config is RE-PROPAGATED, not just deleted: a bare `rm -rf` of the config
// dir would fall back to *code* defaults, not a genuine first-launch. Re-running
// propagateConfigToUser restores the shipped *git-layer* defaults compose-serve
// installs (`serveOne` calls the same function), so the reset lands on the exact
// first-launch config, not a code-default approximation.
//
// OUT OF SCOPE — central secrets / auth tokens: they live in one global encrypted
// store (~/.singularity/state/secrets/) shared by every namespace by the
// single-instance-per-user architecture, carry no per-composition dimension, and
// are deliberately untouched here (see research/2026-07-02-global-adr-single-
// instance-per-user.md).
//
// Never touches main: `assertServableCompositionNamespace` rejects the reserved
// {central, <main namespace>, main} namespaces, and three more provenance guards below
// prove the target is a compose-serve-owned namespace before any data is touched.

import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { rm } from "node:fs/promises";
import {
  propagateConfigToUser,
  readEffectiveConfigFromDisk,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  ensureMainWorktreeRoot,
  hasCompositionMarker,
  namespaceCollision,
  probeNamespace,
} from "@plugins/infra/plugins/worktree/server";
import {
  databaseExists,
  dropDatabase,
  ensureDatabase,
} from "@plugins/database/plugins/admin/server";
import {
  activatedCompositionIds,
  assertServableCompositionNamespace,
  compositionsConfig,
} from "@plugins/plugin-meta/plugins/composition/core";
import { REPO_ROOT, checkoutRef } from "@plugins/infra/plugins/paths/server";
import { configDir } from "@plugins/config_v2/data-dirs";
import {
  namespaceFor,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";

// The `compositions` config's owning-plugin path — its jsonc files live under
// `config/<this>/` and the per-worktree user config dir (mirrors compose-serve).
const COMPOSITIONS_HIERARCHY_PATH = asPath(
  asPluginId("plugin-meta.composition"),
);

/** A refused reset — a guard rejected the target before any data was touched. */
export class CompositionResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositionResetError";
  }
}

/**
 * Wipe one served composition's DB + config back to its first-launch state, then
 * restart its backend. ALL guards must pass, else throw `CompositionResetError`
 * with nothing touched.
 */
export async function resetCompositionData(id: string): Promise<void> {
  // Guard 1 — the explicit "never main/central" gate (rejects the reserved
  // {central, <main namespace>, main} namespaces and enforces a valid name).
  assertServableCompositionNamespace(id);
  // The namespace this composition occupies WHEN SERVED FROM HERE — the same
  // mint the serve build made, so the DB, config dir and marker this reset
  // touches are the ones that build created.
  const ns = namespaceFor(id, await checkoutRef(REPO_ROOT));

  // Guard 2 — the decisive provenance signal: only a compose-serve namespace
  // carries the composition.json marker.
  if (!hasCompositionMarker(ns)) {
    throw new CompositionResetError(
      `reset "${id}": no composition.json marker — not a served composition`,
    );
  }

  const root = REPO_ROOT;

  // THIS CHECKOUT's resolved manifest, read once and judged by both remaining
  // guards. It used to be read main-authoritatively, because the serve stage ran
  // inside main's build and main's config was the only one that mattered; a
  // serve build now reads the manifest of the checkout it runs in, so a guard
  // reading main's would judge the wrong document. Two reads with different
  // options would let the guards disagree about what the manifest says.
  const values = readEffectiveConfigFromDisk(compositionsConfig, {
    root,
    userConfigDir: configDir.file(runtimeNamespace()),
    hierarchyPath: COMPOSITIONS_HIERARCHY_PATH,
  });

  // Guard 3 — no collision with a real git worktree dir, git branch, or a
  // marker-less spec dir of that name. The composition side of the symmetric
  // namespace guard; the checkout side runs in `setupWorktree`.
  //
  // Probed against the MAIN checkout, not `root`. Everything else here is a fact
  // about the checkout this backend runs out of — its manifest, its config — but
  // the probe reads git state, and `.claude/worktrees/` exists only in the main
  // checkout: probing a linked one looks at a path that is never there, so the
  // "a git worktree of that name already owns this namespace" arm could never
  // fire from a worktree backend. `build-targets.ts` resolves the same root for
  // the same reason, and both are memoized, so this is one spawn at most.
  const collision = namespaceCollision(
    ns,
    { kind: "composition", id },
    probeNamespace(
      await ensureMainWorktreeRoot(),
      ns,
      new Set(values.manifests.map((i) => i.id)),
    ),
  );
  if (collision !== null) {
    throw new CompositionResetError(`reset "${id}": ${collision}`);
  }

  // Guard 4 — belt-and-suspenders: `id` must currently be meant to be served
  // (its `serve` mode is anything but `off`) in this checkout's resolved config.
  // Guard 2 (the marker) is the decisive one; this is the second opinion, and it
  // reads the same document the Serve toggle writes on this instance.
  const activated = activatedCompositionIds(values.manifests);
  if (!activated.includes(id)) {
    throw new CompositionResetError(
      `reset "${id}": its serve mode is off in this checkout's config`,
    );
  }

  // Recipe — guards passed; the target is provably this one namespace.
  // Drop + recreate the DB (fresh empty; the backend's boot migrator rebuilds the
  // schema on next spawn).
  if (await databaseExists(ns)) {
    await dropDatabase(ns);
  }
  await ensureDatabase(ns);

  // Wipe the config dir and re-propagate the git-layer first-launch defaults.
  await rm(configDir.file(ns), { recursive: true, force: true });
  await propagateConfigToUser({ root, userConfigDir: configDir.file(ns) });

  await restartNamespace(ns);
}

/**
 * Reboot the composition's backend against the emptied DB. Tolerant, mirroring
 * compose-serve's gateway-notify: resp.ok = restarted; 404 = not running (spawns
 * on first request, fine); a TypeError/DOMException from fetch = the gateway is
 * down (fine — it spawns on first request); anything else is rethrown.
 *
 * Deliberately does NOT call `getAdminPool().end()` — that is a CLI-exit concern;
 * the server's admin pool is long-lived.
 */
async function restartNamespace(ns: Namespace): Promise<void> {
  try {
    await fetch(`http://localhost:9000/gateway/worktrees/${ns}/restart`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    // resp.ok / 404 / other status are all acceptable outcomes here: the backend
    // will (re)spawn against the fresh DB on the next request regardless.
  } catch (err) {
    if (!(err instanceof TypeError) && !(err instanceof DOMException))
      throw err;
    // Gateway unreachable — the backend spawns on first request; nothing to do.
  }
}
