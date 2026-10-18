// localStorage cache of the resolved theme CSS, written by ThemeInjector on every
// change and replayed by the inline pre-paint script in web-core/index.html before
// first paint, so a warm reload paints the correct theme on frame 0.
//
// The envelope is intentionally generic: a map of per-app-path entries, each a
// { styleId -> cssText } map plus the CONFIGURED color mode. The replay script
// knows only this shape, the key, and the `theme-engine-<group>` id convention —
// no token / group / preset knowledge — so web-core stays theme-agnostic (boundary
// rule R10). styleId matches the ids ThemeInjector uses so React adopts the
// replayed <style> elements in place.
//
// Why per-app-path: with per-app themes, the cache must replay the theme of the
// app being loaded, not whichever app last wrote. The replay script longest-
// prefix matches location.pathname against the entry keys (mirroring apps'
// appMatchesPath), falling back to the "" (global) entry.
//
// Who owns the "" (global) entry: now that `:root` carries the FOCUSED full-
// surface app's theme (the "base layer owns `:root`" model), the "" entry must
// hold the *desktop/global* theme, written only when the focus is global
// (desktop/floating → `rootIsGlobal`). A full-surface app focus renders its own
// theme into `:root` and writes only its own app-path key; it must NOT clobber
// "" (else a later cold load of a different path would replay this app's theme as
// the global fallback). See writeCriticalCss.
//
// Why content-addressed and budgeted: an entry is the full theme CSS (~200 KB),
// one per app path, and most apps paint the very same blocks — so storing each
// entry's text inline grew the envelope without bound (7 MB across 19 apps). It
// filled the origin's 10 MB localStorage quota, after which every OTHER
// localStorage write (unsent prompt drafts included) failed. Each distinct CSS
// text is now stored once under its hash, entries name it, and the envelope is
// kept under CACHE_BUDGET by evicting the least recently written app paths.
//
// Why the configured mode (not a resolved dark bit): storing "light"|"dark"|"system"
// lets the replay script re-resolve "system" against live matchMedia on every load,
// so an OS appearance flip between sessions still paints the right scheme.

const KEY = "theme-engine:critical-css";

/**
 * Upper bound on the serialized envelope, in UTF-16 code units (~2 bytes each
 * in storage) — a fifth of the origin's quota, which every other localStorage
 * user shares. Over it, the least recently written app paths are evicted; the
 * entry being written and the "" (global) fallback are never.
 */
export const CACHE_BUDGET = 1_000_000;

import { hashHex } from "@plugins/packages/plugins/string-hash/core";
// The configured setting, one definition shared with the hooks that read it —
// the cache stores exactly what `useConfiguredColorMode()` returns.
import type { ConfiguredColorMode } from "../use-color-mode";
export type CachedColorMode = ConfiguredColorMode;

export interface PaintCacheEntry {
  /** styleId (`theme-engine-<group>`) → hash of its CSS text in `css`. */
  styles: Record<string, string>;
  /** Configured color mode; the replay script re-resolves "system" each load. */
  mode: CachedColorMode;
  /** When this entry was last written (ms epoch) — the eviction order. */
  at: number;
}

export interface CriticalCssEnvelope {
  /** Envelope version — bump to invalidate incompatible caches. */
  v: 4;
  /** Hash → full `:root{…}.dark{…}` CSS text, each distinct text stored once. */
  css: Record<string, string>;
  /** App path ("/agents", "/files", …) → entry. Key "" is the global theme. */
  entries: Record<string, PaintCacheEntry>;
}

function read(): CriticalCssEnvelope | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const env = JSON.parse(raw) as CriticalCssEnvelope;
      if (env && env.v === 4 && env.css && env.entries) return env;
    }
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch {
    // Corrupt / unavailable — start fresh; the runtime path is authoritative
    // and rewrites the whole envelope below.
  }
  return null;
}

/** Keep only the CSS texts some entry still names. */
function collectCss(env: CriticalCssEnvelope): void {
  const live = new Set<string>();
  for (const entry of Object.values(env.entries))
    for (const hash of Object.values(entry.styles)) live.add(hash);
  for (const hash of Object.keys(env.css))
    if (!live.has(hash)) delete env.css[hash];
}

/**
 * Serialize `env` within CACHE_BUDGET, evicting the least recently written
 * entries other than `keep`.
 */
function serializeWithinBudget(
  env: CriticalCssEnvelope,
  keep: ReadonlySet<string>,
): string {
  collectCss(env);
  let text = JSON.stringify(env);
  while (text.length > CACHE_BUDGET) {
    const oldest = Object.entries(env.entries)
      .filter(([path]) => !keep.has(path))
      .sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break; // only kept entries left — they are the cache's point
    delete env.entries[oldest[0]];
    collectCss(env);
    text = JSON.stringify(env);
  }
  return text;
}

// Merge one app's resolved CSS into the per-app envelope (read-merge-write so other
// apps' entries survive — only one app is mounted per page). The "" (global) entry
// is owned ONLY by a global focus (`rootIsGlobal` — desktop/floating): in that case
// `:root` carries the desktop theme, so it is the correct fallback for any path. A
// full-surface app focus (rootScopeId set → `rootIsGlobal` false) renders its OWN
// theme into `:root` and writes only its own app-path key; it must never clobber ""
// with an app-specific theme.
export function writeCriticalCss(opts: {
  appPath: string | undefined;
  styles: Record<string, string>;
  mode: CachedColorMode;
  rootIsGlobal: boolean;
}): void {
  const { appPath, styles, mode, rootIsGlobal } = opts;
  try {
    const stored = read();
    // A previous-version (or corrupt) envelope may be the very blob that filled
    // the quota: drop it before writing, so the write is not refused for it.
    if (!stored) localStorage.removeItem(KEY);
    const env: CriticalCssEnvelope = stored ?? { v: 4, css: {}, entries: {} };
    const refs: Record<string, string> = {};
    for (const [id, text] of Object.entries(styles)) {
      const hash = hashHex(text);
      env.css[hash] = text;
      refs[id] = hash;
    }
    const entry: PaintCacheEntry = { styles: refs, mode, at: Date.now() };
    const path = appPath ?? "";
    env.entries[path] = entry;
    if (rootIsGlobal) env.entries[""] = { ...entry };
    localStorage.setItem(KEY, serializeWithinBudget(env, new Set([path, ""])));
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch {
    // Quota exceeded / storage disabled — the cache is a best-effort first-paint
    // optimization; a miss degrades to the neutral cold floor, never breaks.
  }
}
