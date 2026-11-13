import { endpointPath } from "@plugins/infra/plugins/endpoints/server";
import { DocumentHead } from "@plugins/shell/plugins/document-head/server";
import {
  getSavedSpriteAsset,
  getSpriteAsset,
  RESIDENT_SPRITE_KEYS,
} from "../../core";
import { HEAD_REQUEST_GLOBAL } from "../../shared/head-request";
import { symbolsHash } from "./drawer";
import { SpriteDrawer } from "./sprite-drawer";

/**
 * The head script that starts the sprite requests at t0 (`HeadSpriteRequests`):
 * every resident sprite under the drawer's hash, and the saved-icon sprites
 * under the symbols hash. An inline async module importing nothing, so it runs
 * as soon as the parser reaches it, while the modulepreloads download — the
 * same shape as the boot snapshot's head request. Each `.catch` only marks a
 * promise handled; the boot task awaits the same promises and sees a failure.
 *
 * Both hashes are fixed for the backend's life, so the script is a constant:
 * a head written by an earlier backend names that backend's hashes, which this
 * one answers 409 — the boot task then leaves those sprites to the page's
 * live reads.
 */
export function spritesHeadScript(): string {
  const hash = SpriteDrawer.get().manifestHash;
  const resident = Object.fromEntries(
    RESIDENT_SPRITE_KEYS.map((key) => [
      key,
      endpointPath(getSpriteAsset, { hash, key }),
    ]),
  );
  const saved = endpointPath(getSavedSpriteAsset, { hash: symbolsHash() });
  return (
    `<script type="module" async>` +
    `const get = (p) => { const r = fetch(p); r.catch(() => undefined); return r; };` +
    `const startMs = performance.now();` +
    `const sprites = {};` +
    `for (const [k, p] of Object.entries(${JSON.stringify(resident)})) sprites[k] = get(p);` +
    `globalThis[${JSON.stringify(HEAD_REQUEST_GLOBAL)}] = { startMs, resident: { hash: ${JSON.stringify(hash)}, sprites }, saved: get(${JSON.stringify(saved)}) };` +
    `</script>`
  );
}

/** Every page of the shell draws icons at its first paint: the `""` key. */
export const spritesHead = DocumentHead.Fragment({
  id: "icon-sprites",
  render: () => Promise.resolve({ "": spritesHeadScript() }),
  // A constant: both hashes are fixed while the backend runs.
  subscribe: () => () => undefined,
});
