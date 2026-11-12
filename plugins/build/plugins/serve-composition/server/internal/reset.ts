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
// propagateConfigToUser (as `./equin config-propagate`, in a child: it evaluates
// every plugin barrel, build tooling that never runs in a serving backend)
// restores the shipped *git-layer* defaults a serve build installs (the build
// calls the same function), so the reset lands on the exact first-launch config,
// not a code-default approximation.
//
// OUT OF SCOPE — central secrets / auth tokens: they live in one global encrypted
// store (~/.equin/state/secrets/) shared by every namespace by the
// single-instance-per-user architecture, carry no per-composition dimension, and
// are deliberately untouched here (see research/2026-07-02-global-adr-single-
// instance-per-user.md).
//
// Never touches main: `assertServableCompositionNamespace` rejects the reserved
// {central, <main namespace>, main} namespaces, and three more provenance guards below
// prove the target is a compose-serve-owned namespace before any data is touched.

import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { rm } from "node:fs/promises";
import { z } from "zod";
import {
  ensureMainWorktreeRoot,
  hasCompositionMarker,
  namespaceCollision,
  probeNamespace,
} from "@plugins/infra/plugins/worktree/server";
import { recreateDatabase } from "@plugins/database/plugins/admin/server";
import {
  activatedCompositionIds,
  assertServableCompositionNamespace,
} from "@plugins/plugin-meta/plugins/composition/core";
import { checkoutRef } from "@plugins/infra/plugins/paths/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { configDir } from "@plugins/config_v2/data-dirs";
import {
  namespaceFor,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import {
  readCompositionManifests,
  repropagateConfig,
} from "./config-propagation";

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
 *
 * `manifestNamespace` is the namespace whose user config layer holds this
 * checkout's composition manifests — the answering backend's own
 * (`runtimeNamespace()`) for the endpoint; a CLI acting on a checkout, which has
 * no runtime namespace, passes the checkout's (`checkoutNamespace(root)`).
 */
export async function resetCompositionData(
  id: string,
  manifestNamespace: Namespace = runtimeNamespace(),
): Promise<void> {
  // Guard 1 — the explicit "never main/central" gate (rejects the reserved
  // {central, <main namespace>, main} namespaces and enforces a valid name).
  assertServableCompositionNamespace(id);
  // The namespace this composition occupies WHEN SERVED FROM HERE — the same
  // mint the serve build made, so the DB, config dir and marker this reset
  // touches are the ones that build created.
  const ns = namespaceFor(id, await checkoutRef(REPO_ROOT));

  // Guard 2 — the decisive provenance signal: only a compose-serve namespace
  // carries the composition.json marker.
  if (!(await hasCompositionMarker(ns))) {
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
  const values = await readCompositionManifests(
    root,
    configDir.file(manifestNamespace),
  );

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
    await probeNamespace(
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
  //
  // ORDER IS THE POINT. The backend serving this namespace booted on the
  // database about to be dropped; it must be gone — and unable to come back —
  // before that database is. It used to be dropped and recreated under the
  // serving backend, with a hot restart asked for afterwards: a hot restart is
  // zero-downtime, so the OLD backend kept serving while its successor migrated
  // the empty database, then died on `relation "reports" does not exist` /
  // graphile's "breaking migration" (report-1794167098-q99s8d). So: stop it
  // HELD (no request may cold-start one onto the database mid-replace), replace
  // the data, then cold-start it — a backend booted on the new database only.
  await holdBackendDown(ns);

  // Drop + recreate the DB (fresh empty; the backend's boot migrator rebuilds
  // the schema on the cold start below).
  // One step as the pooler sees it: a drop-then-create left a window in which
  // PgBouncer (refilling the pool) logged in to the missing database and cached
  // that failure for the restarted backend.
  await recreateDatabase(ns);

  // Wipe the config dir and re-propagate the git-layer first-launch defaults.
  await rm(configDir.file(ns), { recursive: true, force: true });
  await repropagateConfig(root, configDir.file(ns));

  await startBackend(ns);
}

const gatewayWorktreeUrl = (ns: Namespace, action: "stop" | "restart") =>
  `http://localhost:9000/gateway/worktrees/${encodeURIComponent(ns)}/${action}`;

/**
 * Stop the namespace's backend and HOLD it down: the gateway answers traffic
 * with "held" instead of cold-starting a backend, until `startBackend`'s deploy
 * start releases it. Throws unless the gateway confirms the hold — a gateway
 * that predates `?hold=1` stops the backend but holds nothing, and proceeding
 * on that would reopen the window this closes.
 *
 * Two answers mean nothing can be running, so there is nothing to hold: an
 * unreachable gateway (every backend is its child) and 404 (the namespace is
 * not registered, so the gateway cannot start it).
 */
async function holdBackendDown(ns: Namespace): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(`${gatewayWorktreeUrl(ns, "stop")}?hold=1`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if (err instanceof TypeError) return; // gateway down: no backend runs
    throw err;
  }
  if (resp.status === 404) return;
  const body = await resp.text();
  if (!resp.ok) {
    throw new CompositionResetError(
      `reset "${ns}": could not stop its backend before replacing its database ` +
        `(gateway ${resp.status}: ${body.trim()}); nothing was touched.`,
    );
  }
  const status = z
    .object({ held: z.boolean().optional() })
    .parse(JSON.parse(body));
  if (status.held !== true) {
    throw new CompositionResetError(
      `reset "${ns}": the gateway stopped its backend but did not hold it down ` +
        `(it predates the held stop — main's next deploy updates it); refusing to ` +
        `replace the database while traffic could boot a backend onto it. ` +
        `Nothing was touched; the backend cold-starts on the next request.`,
    );
  }
}

/**
 * Cold-start the namespace's backend on the replaced database — a deploy start,
 * which is also what releases `holdBackendDown`'s hold. Waits for it to be
 * ready, so a caller's next request (the promo-film seed) reaches the new one.
 * An unreachable gateway or an unregistered namespace starts nothing to wait
 * for (it spawns on first request); any other failure is the reset's.
 *
 * Deliberately does NOT call `getAdminPool().end()` — that is a CLI-exit concern;
 * the server's admin pool is long-lived.
 */
async function startBackend(ns: Namespace): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(gatewayWorktreeUrl(ns, "restart"), {
      method: "POST",
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    if (err instanceof TypeError) return; // gateway down: spawns on first request
    throw err;
  }
  if (resp.ok || resp.status === 404) return;
  throw new CompositionResetError(
    `reset "${ns}": its database was reset, but its backend failed to boot on ` +
      `it (gateway ${resp.status}: ${(await resp.text()).trim()}).`,
  );
}
