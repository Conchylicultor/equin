import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  DEFAULT_ICON_STYLE,
  DEFAULT_STYLE_KEYS,
  styleKeyOf,
  type IconStyle,
  type StyleKey,
} from "../../core";

/**
 * What each theme scope says about its icons, published by whoever resolves
 * themes (the icons token group) and read by every `<Icon>`. The icons plugin
 * itself knows no theme: it sits below the ui-kit, which draws icons, so it
 * cannot import the theme engine that sits above it.
 *
 * Keyed by scope token; `ROOT` is the scope outside every boundary (`:root`).
 * A scope with no entry draws in the root's style — the same fallback the CSS
 * has, where a scope with no theme block of its own inherits `:root`.
 */
const ROOT = "";

const styles = new Map<string, IconStyle>();
const listeners = new Set<() => void>();
// Bumped on every change; the wanted-keys snapshot is cached against it.
// eslint-disable-next-line scoped-store/no-module-mutable-store -- page-global by design: a scope token names the same theme scope in every surface, and its icon style is the theme's, not a surface's
let version = 0;

function emit(): void {
  version++;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Publish `scope`'s icon style for as long as the caller is mounted (undefined
 * `scope` = the root). One publisher per scope: a second one is a wiring bug,
 * so it throws rather than letting the later mount silently win.
 */
export function usePublishIconStyle(
  scope: string | undefined,
  style: IconStyle,
): void {
  const key = scope ?? ROOT;
  const { family, shape, fill, activeFill, weight } = style;
  useLayoutEffect(() => {
    if (styles.has(key)) {
      throw new Error(
        `[icons] two publishers claim the icon style of scope "${key || "root"}"`,
      );
    }
    styles.set(key, { family, shape, fill, activeFill, weight });
    emit();
    return () => {
      styles.delete(key);
      emit();
    };
  }, [key, family, shape, fill, activeFill, weight]);
}

/** The icon style of `scope`: its own, else the root's, else the global default. */
export function iconStyleOf(scope: string | undefined): IconStyle {
  return (
    (scope !== undefined ? styles.get(scope) : undefined) ??
    styles.get(ROOT) ??
    DEFAULT_ICON_STYLE
  );
}

export function useScopeIconStyle(scope: string | undefined): IconStyle {
  return useSyncExternalStore(subscribe, () => iconStyleOf(scope));
}

/**
 * The icon style of each of `scopes`, in order — what an `<Icon>` inside each
 * draws with (its own published style, else the root's, else the default). For
 * a surface listing many scopes at once (Debug → Icons: every app's family),
 * where one `useScopeIconStyle` per scope would be a hook in a loop.
 */
export function useScopeIconStyles(
  scopes: readonly (string | undefined)[],
): readonly IconStyle[] {
  // The scopes as one value, so a fresh array of the same scopes is no change.
  const key = JSON.stringify(scopes.map((s) => s ?? ROOT));
  // The snapshot itself is the answer, re-read on every publish. (A useMemo
  // keyed on a version it never reads is a dependency the React Compiler
  // drops: the styles froze at the first render, before any publish.)
  return useSyncExternalStore(subscribe, () => scopeStylesSnapshot(key));
}

const scopeStylesCache = new Map<
  string,
  { version: number; styles: readonly IconStyle[] }
>();

/** The styles of the scope list `key`, the same array until the store changes. */
function scopeStylesSnapshot(key: string): readonly IconStyle[] {
  const hit = scopeStylesCache.get(key);
  if (hit?.version === version) return hit.styles;
  const styles = (JSON.parse(key) as (string | undefined)[]).map((s) =>
    iconStyleOf(s === ROOT ? undefined : s),
  );
  scopeStylesCache.set(key, { version, styles });
  return styles;
}

// eslint-disable-next-line scoped-store/no-module-mutable-store -- a memo of the page-global style map above (see `version`)
let wantedCache: { version: number; keys: readonly StyleKey[] } | undefined;

function wantedStyleKeys(): readonly StyleKey[] {
  if (wantedCache?.version === version) return wantedCache.keys;
  const keys = new Set<StyleKey>(DEFAULT_STYLE_KEYS);
  for (const style of styles.values()) {
    keys.add(styleKeyOf(style, false));
    keys.add(styleKeyOf(style, true));
  }
  wantedCache = { version, keys: [...keys].sort() };
  return wantedCache.keys;
}

/** Every sprite some scope can draw from right now (always including the default style's). */
export function useWantedStyleKeys(): readonly StyleKey[] {
  return useSyncExternalStore(subscribe, wantedStyleKeys);
}
