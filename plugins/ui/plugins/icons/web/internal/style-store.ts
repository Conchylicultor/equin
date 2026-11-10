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
 * A scope with no entry draws in the style of the scope around it — the same
 * fallback the CSS has, where a scope with no theme block of its own inherits.
 * A WHOLE entry (an app's theme, a fixed theme, the root) is a complete style;
 * a LAYER (a sub-theme) names only the axes it changes, worn over the style of
 * whatever scope encloses it.
 */
const ROOT = "";

type Published =
  | { layer: false; style: IconStyle }
  | { layer: true; style: Partial<IconStyle> };

const styles = new Map<string, Published>();
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
  usePublish(scope ?? ROOT, false, style);
}

/**
 * Publish a LAYER for `scope`: only the axes `style` names, drawn over the
 * style of the scope enclosing it (a sub-theme's region). Same lifetime and
 * one-publisher rule as {@link usePublishIconStyle}.
 */
export function usePublishIconStyleLayer(
  scope: string,
  style: Partial<IconStyle>,
): void {
  usePublish(scope, true, style);
}

function usePublish(
  key: string,
  layer: boolean,
  style: Partial<IconStyle>,
): void {
  const { family, shape, fill, activeFill, weight } = style;
  useLayoutEffect(() => {
    if (styles.has(key)) {
      throw new Error(
        `[icons] two publishers claim the icon style of scope "${key || "root"}"`,
      );
    }
    const own = withoutUndefined({ family, shape, fill, activeFill, weight });
    styles.set(
      key,
      layer
        ? { layer: true, style: own }
        : { layer: false, style: own as IconStyle },
    );
    emit();
    return () => {
      styles.delete(key);
      emit();
    };
  }, [key, layer, family, shape, fill, activeFill, weight]);
}

function withoutUndefined(style: Partial<IconStyle>): Partial<IconStyle> {
  return Object.fromEntries(
    Object.entries(style).filter(([, v]) => v !== undefined),
  ) as Partial<IconStyle>;
}

/**
 * The icon style an `<Icon>` inside the boundaries `chain` (nearest first) draws
 * with: the nearest WHOLE style (else the root's, else the global default),
 * with every layer between it and the icon applied over it, outermost first.
 */
export function iconStyleOf(chain: readonly string[]): IconStyle {
  const layers: Partial<IconStyle>[] = [];
  let base: IconStyle | undefined;
  for (const scope of chain) {
    const entry = styles.get(scope);
    if (entry === undefined) continue;
    if (!entry.layer) {
      base = entry.style;
      break;
    }
    layers.push(entry.style);
  }
  base ??= rootStyle();
  if (layers.length === 0) return base;
  return layers.reduceRight<IconStyle>(
    (style, layer) => ({ ...style, ...layer }),
    base,
  );
}

function rootStyle(): IconStyle {
  const root = styles.get(ROOT);
  return root !== undefined && !root.layer ? root.style : DEFAULT_ICON_STYLE;
}

/**
 * The style of `chain`, the same object until the store changes — so a merged
 * (layered) style is a stable snapshot for useSyncExternalStore.
 */
const chainStyleCache = new Map<
  string,
  { version: number; style: IconStyle }
>();

function chainStyleSnapshot(chain: readonly string[]): IconStyle {
  if (chain.length === 0) return iconStyleOf(chain);
  const key = chain.join("\n");
  const hit = chainStyleCache.get(key);
  if (hit?.version === version) return hit.style;
  const style = iconStyleOf(chain);
  chainStyleCache.set(key, { version, style });
  return style;
}

export function useScopeIconStyle(chain: readonly string[]): IconStyle {
  return useSyncExternalStore(subscribe, () => chainStyleSnapshot(chain));
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
  const styles = (JSON.parse(key) as string[]).map((s) =>
    iconStyleOf(s === ROOT ? [] : [s]),
  );
  scopeStylesCache.set(key, { version, styles });
  return styles;
}

// eslint-disable-next-line scoped-store/no-module-mutable-store -- a memo of the page-global style map above (see `version`)
let wantedCache: { version: number; keys: readonly StyleKey[] } | undefined;

function wantedStyleKeys(): readonly StyleKey[] {
  if (wantedCache?.version === version) return wantedCache.keys;
  const keys = new Set<StyleKey>(DEFAULT_STYLE_KEYS);
  const add = (style: IconStyle) => {
    keys.add(styleKeyOf(style, false));
    keys.add(styleKeyOf(style, true));
  };
  // Every whole style, and every layer worn over each of them — a layer can
  // sit in any scope (a media player's sub-theme inside any app).
  const wholes = [DEFAULT_ICON_STYLE];
  const layers: Partial<IconStyle>[] = [];
  for (const entry of styles.values()) {
    if (entry.layer) layers.push(entry.style);
    else wholes.push(entry.style);
  }
  for (const whole of wholes) {
    add(whole);
    for (const layer of layers) add({ ...whole, ...layer });
  }
  wantedCache = { version, keys: [...keys].sort() };
  return wantedCache.keys;
}

/** Every sprite some scope can draw from right now (always including the default style's). */
export function useWantedStyleKeys(): readonly StyleKey[] {
  return useSyncExternalStore(subscribe, wantedStyleKeys);
}
