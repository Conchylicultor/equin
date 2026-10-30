import { listPrototypeNames } from "@plugins/apps/plugins/prototypes/plugins/files/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import type { ThumbnailState } from "../../core";
import { hasThumbnail } from "./cache";
import { decideThumbnail } from "./decide";
import { fingerprintPrototype } from "./fingerprint";
import { ThumbnailRenderer, type ThumbnailRenderRequest } from "./renderer";
import {
  patchThumbnailStates,
  readThumbnailState,
  replaceThumbnailStates,
} from "./state";

/**
 * Reconcile every prototype's thumbnail state against its files and the cache,
 * and ask the host's renderer for whatever is missing — at boot, and when the
 * browser install settles.
 *
 * This and {@link syncChangedThumbnails} are the only places that decide what
 * needs rendering, and both decide from the fingerprint alone — so they are
 * idempotent. A prototype that vanished loses its state by construction (the
 * map is rebuilt, not patched). On a host with no renderer a miss is
 * `unavailable` (`decideThumbnail`), so the same pass serves a seeded cache's
 * hits there with no branch of its own.
 *
 * It needs the prototypes' NAMES, nothing else, so it reads the folder listing
 * (`listPrototypeNames`) — never `listPrototypeMetas`, which reads, validates
 * and parses every folder and was 2–4 s of this pass's ~3 s on main.
 */
export async function syncThumbnails(): Promise<void> {
  const renderer = ThumbnailRenderer.get();
  const next = new Map<string, ThumbnailState>();
  const pending = await decideAll(await listPrototypeNames(), next, renderer);
  replaceThumbnailStates(next);
  await requestRenders(renderer, pending);
}

/**
 * The boot reconcile, as a declared warm-up rather than a fire-and-forget in
 * `onReady`: it reads and hashes every prototype's bytes (130 prototypes /
 * 15 MB on the desktop: ~1.8 s standalone, half of it the pure-JS sha256;
 * 3.6 s as a boot warm-up beside the rest of the drain), which on every
 * backend's boot competed with the boot hooks and first requests. The drain
 * runs it once the host has settled, under the executor's gate and slot.
 * `worktree` scope: the state it rebuilds is this backend's own memory.
 *
 * Until it runs, a card has no state — the same as before any sync — and an
 * edit in the meantime still re-decides its prototype (`onPrototypesChanged`).
 */
export const thumbnailsSyncWarmup = defineWarmup({
  name: "prototype-thumbnails.sync",
  description:
    "Checks every prototype's gallery preview against its files and renders the ones that are missing or out of date.",
  scope: "worktree",
  budgetMs: 6000,
  run: () => syncThumbnails(),
});

/**
 * Re-decide only the prototypes a tree change named (`onPrototypesChanged`
 * hands them over) — an edit to one prototype re-fingerprints that one folder,
 * not all of them. A named prototype that is gone loses its state.
 */
export async function syncChangedThumbnails(
  changed: readonly string[],
): Promise<void> {
  const renderer = ThumbnailRenderer.get();
  const next = new Map<string, ThumbnailState>();
  const pending = await decideAll(changed, next, renderer);
  const gone = changed.filter((name) => !next.has(name));
  patchThumbnailStates(next, gone);
  await requestRenders(renderer, pending);
}

type Renderer = ReturnType<typeof ThumbnailRenderer.get>;

/** Decide each named prototype into `next`; returns the renders it needs. */
async function decideAll(
  names: readonly string[],
  next: Map<string, ThumbnailState>,
  renderer: Renderer,
): Promise<ThumbnailRenderRequest[]> {
  const pending: ThumbnailRenderRequest[] = [];
  for (const name of names) {
    const fingerprint = await fingerprintPrototype(name);
    // Not in the tree: deleted between the listing and the hash (the watcher
    // fires again for the removal), or a change that named a removed
    // prototype. Either way it has no state.
    if (fingerprint.kind === "missing") continue;
    const { key } = fingerprint;

    const decision = decideThumbnail(
      key,
      await hasThumbnail(key),
      readThumbnailState(name),
      renderer,
    );
    next.set(name, decision.state);
    if (decision.render) pending.push({ name, key });
  }
  return pending;
}

// Ask after the push, so an open gallery shows `rendering` immediately rather
// than after the queue round-trip. Only a host that renders ever decides
// `render`.
async function requestRenders(
  renderer: Renderer,
  pending: readonly ThumbnailRenderRequest[],
): Promise<void> {
  if (renderer.kind !== "renders") return;
  for (const item of pending) {
    await renderer.request(item);
  }
}
