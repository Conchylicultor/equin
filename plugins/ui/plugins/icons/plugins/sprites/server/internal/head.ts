import { endpointPath } from "@plugins/infra/plugins/endpoints/server";
import { DocumentHead } from "@plugins/shell/plugins/document-head/server";
import {
  getGlyphAsset,
  getSpriteAsset,
  RESIDENT_SPRITE_KEYS,
} from "../../core";
import { ownerPrefix } from "@plugins/primitives/plugins/dom/plugins/web-storage/core";
import {
  FIRST_FRAME_MEMORY_OWNER,
  FIRST_FRAME_PAGE_JS,
  HEAD_REQUEST_GLOBAL,
} from "../../shared/head-request";
import { SpriteDrawer } from "./sprite-drawer";

/** Placeholders the head script swaps for a remembered batch's address. */
const HASH = "__hash__";
const KEY = "__key__";
const NAMES = "__names__";

/**
 * The head script that starts the icon requests at t0 (`HeadSpriteRequests`):
 * every resident whole sprite (the brands) under the drawer's hash, and every
 * glyph batch the page's last first frame drew (`FIRST_FRAME_MEMORY_OWNER`'s
 * entry for the page, in localStorage — content-addressed assets, read from the browser's cache on a
 * warm load). An inline async module importing nothing, so it runs as soon as
 * the parser reaches it, while the modulepreloads download — the same shape
 * as the boot snapshot's head request. Each `.catch` only marks a promise
 * handled; the boot task awaits the same promises and sees a failure.
 *
 * A first visit remembers nothing: its first frame asks for its glyphs once
 * the app renders, and paints when they land (the sprite host's first-frame
 * gate). The drawer's hash is fixed for the backend's life, so the script is a
 * constant: a head written by an earlier backend names that backend's hash,
 * which this one answers 409 — the boot task then leaves that sprite to the
 * page's live reads. A remembered batch carries its own hash and is answered
 * 409 the same way when it is not the host's any more.
 */
export function spritesHeadScript(): string {
  const hash = SpriteDrawer.get().manifestHash;
  const resident = Object.fromEntries(
    RESIDENT_SPRITE_KEYS.map((key) => [
      key,
      endpointPath(getSpriteAsset, { hash, key }),
    ]),
  );
  const glyphPath = endpointPath(getGlyphAsset, {
    hash: HASH,
    key: KEY,
    names: NAMES,
  });
  return (
    `<script type="module" async>` +
    `const get = (p) => { const r = fetch(p); r.catch(() => undefined); return r; };` +
    `const startMs = performance.now();` +
    `const sprites = {};` +
    `for (const [k, p] of Object.entries(${JSON.stringify(resident)})) sprites[k] = get(p);` +
    `const page = ${FIRST_FRAME_PAGE_JS};` +
    // Parked first, so a memory that cannot be read costs only the memory.
    `const parked = { startMs, resident: { hash: ${JSON.stringify(hash)}, sprites }, page, glyphs: [], memoryError: null };` +
    `globalThis[${JSON.stringify(HEAD_REQUEST_GLOBAL)}] = parked;` +
    // The web-storage envelope `{ v, ts, s }` of the page's entry. An entry
    // another build wrote may hold another shape: only well-formed batches
    // are fetched. A failure to read it (storage blocked, a corrupt entry) is
    // handed to the boot task, which reports it.
    `try {` +
    `const memory = JSON.parse(localStorage.getItem(${JSON.stringify(ownerPrefix(FIRST_FRAME_MEMORY_OWNER))} + page) ?? "null");` +
    `const batches = (Array.isArray(memory?.v) ? memory.v : []).filter((b) => [b?.hash, b?.key, b?.names].every((x) => typeof x === "string" && /^[a-z0-9,-]+$/.test(x)));` +
    `parked.glyphs = batches.map((b) => ({ hash: b.hash, key: b.key, names: b.names, response: get(${JSON.stringify(glyphPath)}` +
    `.replace(${JSON.stringify(HASH)}, b.hash).replace(${JSON.stringify(KEY)}, b.key).replace(${JSON.stringify(NAMES)}, b.names)) }));` +
    `} catch (err) { parked.memoryError = String(err); }` +
    `</script>`
  );
}

/** Every page of the shell draws icons at its first paint: the `""` key. */
export const spritesHead = DocumentHead.Fragment({
  id: "icon-sprites",
  render: () => Promise.resolve({ "": spritesHeadScript() }),
  // A constant: the drawer's hash is fixed while the backend runs.
  subscribe: () => () => undefined,
});
