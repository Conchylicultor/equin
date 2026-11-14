/**
 * Wait until the deploy under test is not being changed.
 *
 * A build's exit marker is not the end of a deploy: on main, the convergence
 * run that ran the build goes on to follow main's gateway, which can restart
 * the gateway — and with it every backend — seconds later. A script started on
 * the marker (main's `desktop.fullscreen-budget` job) drove main straight
 * through that restart: `ERR_CONNECTION_REFUSED` on the page's own modules, the
 * demo's in-browser host failing to load its plugins, and a 30 s wait for a
 * window that never came (2026-11-11 … 11-14, every failing run).
 *
 * The convergence run holds the namespace's deploy lock exclusively for its
 * whole run (`worktreeArtifacts.deployLock`), so this takes it SHARED — granted
 * the instant no run holds it, pushed by the kernel, no polling — and drops it
 * at once: a measurement must never hold a deploy back. A deploy that starts
 * after this returns is a new deploy, not the one this waited out.
 *
 * Nothing ever holds the lock of a namespace no convergence run deploys (an
 * agent's worktree), so there it returns at once.
 */

import { waitForFlock } from "@plugins/packages/plugins/flock/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import { targetNamespace } from "./target";

/** How long a wait goes unannounced: past it, the script says what it waits on. */
const ANNOUNCE_AFTER_MS = 1000;

export async function awaitDeploySettled(): Promise<void> {
  const namespace = targetNamespace();
  const startedAt = Date.now();
  // One-shot: names the wait in the transcript once it is a real one.
  const announce = setTimeout(() => {
    console.log(
      `waiting for ${namespace}'s deploy to finish (a convergence run holds its deploy lock)…`,
    );
  }, ANNOUNCE_AFTER_MS);
  try {
    const held = await waitForFlock(worktreeArtifacts.deployLock(namespace), {
      shared: true,
    });
    await held.release();
  } finally {
    clearTimeout(announce);
  }
  const waitedMs = Date.now() - startedAt;
  if (waitedMs >= ANNOUNCE_AFTER_MS)
    console.log(
      `${namespace}'s deploy settled after ${Math.round(waitedMs / 1000)} s`,
    );
}
