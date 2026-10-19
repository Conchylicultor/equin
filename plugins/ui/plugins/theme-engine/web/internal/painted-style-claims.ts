// Which painted `<style>` elements a live painter still owns. The first frame's
// theme CSS arrives in the HTML, rendered by the server (theme-engine/server's
// document head) under the same ids the browser's painters use, so each painter
// ADOPTS its element in place rather than creating a second one. The server
// cannot know everything the browser will mount (which apps the surface shows,
// a token group retired by a newer build), so an element no mounted painter
// claims must go, or it keeps declaring dead or wrong vars.
//
// A module singleton because the painters live in different React subtrees
// (ThemeInjector, AppScopeThemes, SubThemeStyles, FixedThemeStyles — all
// Core.Root siblings) and cannot share a context.
//
// Each painter CLAIMS its id in its insertion effect; a prune scheduled as a
// following microtask removes every painted element whose id is unclaimed.
// React runs all of a commit's insertion effects synchronously, so every claim
// of the current commit is registered before the prune runs — a still-mounted
// element is never removed.

import { THEME_STYLE_ID_PREFIXES } from "../../core";

const claimed = new Set<string>();
let pruneScheduled = false;

/** Claim a styleId (from a mounted painter's effect) and schedule a prune. */
export function claimPaintedStyle(styleId: string): void {
  claimed.add(styleId);
  if (pruneScheduled) return;
  pruneScheduled = true;
  queueMicrotask(prune);
}

/** Release a styleId (painter cleanup). */
export function releasePaintedStyle(styleId: string): void {
  claimed.delete(styleId);
}

const PAINTED_SELECTOR = THEME_STYLE_ID_PREFIXES.map(
  (prefix) => `style[id^="${prefix}"]`,
).join(", ");

function prune(): void {
  pruneScheduled = false;
  for (const el of document.querySelectorAll<HTMLStyleElement>(
    PAINTED_SELECTOR,
  )) {
    if (!claimed.has(el.id)) el.remove();
  }
}
