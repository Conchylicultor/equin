import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";
import {
  COLOR_SCHEME_ATTR,
  isSubThemeScope,
  MAX_SCHEME_ALTERNATIONS,
  PLUGIN_SCOPE_ROOT_THEME,
  type ColorScheme,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { PortalForwardProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

// ── Which scheme each theme scope wears ────────────────────────────────────
//
// Published by whoever resolves light/dark (theme-engine: each app's effective
// colour mode, each fixed theme's scheme, the desktop's for the root) and read
// by every `<Theme>` boundary, which stamps it. This primitive knows no config
// and no app: it sits below the theme engine, which imports it.
//
// Keyed by the plugin scope it was published from and the BARE scope token;
// `ROOT` is the scope outside every boundary (the desktop's — `<html>`'s on the
// page, the plugin scope's root boundary inside one). A token with no entry
// (a sub-theme's, an unpublished one) stamps nothing: the region wears the
// scheme around it.

const ROOT = "";

/** The store key of theme scope `scope` published from plugin scope `pluginScope`. */
function keyOf(pluginScope: string | null, scope: string): string {
  return `${pluginScope ?? ""}\u0000${scope}`;
}

const schemes = new Map<string, ColorScheme>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Publish the scheme theme scope `scope` wears (undefined = the root: outside
 * every boundary) for as long as the caller is mounted. One publisher per
 * scope: a second is a wiring bug, so it throws rather than letting the later
 * mount silently win.
 *
 * A layout effect: a boundary mounting in the same commit as its publisher
 * (the first one of a page) stamps its scheme in the synchronous re-render
 * this triggers, before the browser paints.
 */
export function usePublishColorScheme(
  scope: string | undefined,
  scheme: ColorScheme,
): void {
  const key = keyOf(usePluginScopeId(), scope ?? ROOT);
  useLayoutEffect(() => {
    if (schemes.has(key)) {
      throw new Error(
        `[theme-boundary] two publishers claim the colour scheme of scope "${key.replace("\u0000", " ") || "root"}"`,
      );
    }
    schemes.set(key, scheme);
    emit();
    return () => {
      schemes.delete(key);
      emit();
    };
  }, [key, scheme]);
}

/** The store key a boundary named `name` reads its scheme under, or undefined
 *  for a boundary that keeps the scheme around it. */
function schemeKeyOf(
  pluginScope: string | null,
  name: string | undefined,
): string | undefined {
  if (name === undefined || isSubThemeScope(name)) return undefined;
  return keyOf(pluginScope, name === PLUGIN_SCOPE_ROOT_THEME ? ROOT : name);
}

/**
 * The scheme theme scope `name` wears as published (undefined while its
 * publisher has not mounted, or for a scope that keeps the scheme around it —
 * a sub-theme's). For a surface that needs a NAMED scope's scheme outside its
 * region (the icon-style bridge); inside a region, {@link useColorScheme}.
 */
export function usePublishedColorScheme(
  name: string | undefined,
): ColorScheme | undefined {
  const key = schemeKeyOf(usePluginScopeId(), name);
  const [, rerender] = useState(0);
  // Subscribed in a LAYOUT effect, not `useSyncExternalStore`'s passive one:
  // the publisher writes in a layout effect of the same commit (the first one
  // of a page), and a passive subscription would only catch that after the
  // browser had painted the boundary unstamped — in the scheme around it, then
  // flipping. Re-checked after subscribing, so a publish that landed earlier in
  // this commit's layout phase is caught too; either way the re-render is
  // synchronous, before paint. The value itself is always read from the store.
  const seen = key === undefined ? undefined : schemes.get(key);
  useLayoutEffect(() => {
    const sync = () => {
      if ((key === undefined ? undefined : schemes.get(key)) !== seen) {
        rerender((n) => n + 1);
      }
    };
    sync();
    return subscribe(sync);
  }, [key, seen]);
  return seen;
}

// ── The nearest carrier, in React ──────────────────────────────────────────

interface SchemeContext {
  scheme: ColorScheme;
  /** Carriers in the collapsed chain since the outermost dark one (0: none dark yet). */
  alternations: number;
}

const ColorSchemeContext = createContext<SchemeContext | null>(null);

/** The root's scheme: as published, else what `<html>` carries now (the
 *  server's first frame set it before anything mounted). */
function useRootScheme(): ColorScheme {
  const published = usePublishedColorScheme(PLUGIN_SCOPE_ROOT_THEME);
  if (published !== undefined) return published;
  return typeof document !== "undefined" &&
    document.documentElement.getAttribute(COLOR_SCHEME_ATTR) === "dark"
    ? "dark"
    : "light";
}

/**
 * The colour scheme this subtree wears: the nearest scheme boundary's, else
 * the root's (the desktop's). The JS twin of what the CSS resolves from the
 * nearest `data-color-scheme` carrier, for whatever themes itself in JS — a
 * prop-themed widget (charts, code highlighting, a toaster) renders in the
 * scheme of the region it sits in, not in `<html>`'s.
 */
export function useColorScheme(): ColorScheme {
  const ctx = useContext(ColorSchemeContext);
  const root = useRootScheme();
  return ctx?.scheme ?? root;
}

/**
 * Makes `scheme` the scheme of the subtree: the React context
 * ({@link useColorScheme}) and the portal forward that re-stamps
 * `data-color-scheme` on popups opened from it (`reach` as the theme token's).
 * The caller stamps the attribute on its own element. `undefined` keeps the
 * scheme around it.
 *
 * Throws past {@link MAX_SCHEME_ALTERNATIONS}: the nearest-carrier selector
 * resolves only that many alternations, and deeper ones would render in the
 * wrong scheme silently.
 */
export function ColorSchemeProvider({
  scheme,
  reach = "all",
  children,
}: {
  scheme: ColorScheme | undefined;
  reach?: "all" | "popups";
  children: ReactNode;
}) {
  const parent = useContext(ColorSchemeContext);
  const root = useRootScheme();
  // Outside every boundary the chain starts at the root carrier (`<html>`).
  const outerScheme = parent?.scheme ?? root;
  const outerAlternations = parent?.alternations ?? (root === "dark" ? 1 : 0);
  const value = useMemo<SchemeContext | null>(() => {
    if (scheme === undefined || reach === "popups") return parent;
    if (scheme === outerScheme) {
      return { scheme, alternations: outerAlternations };
    }
    const alternations =
      outerAlternations === 0
        ? scheme === "dark"
          ? 1
          : 0
        : outerAlternations + 1;
    return { scheme, alternations };
  }, [scheme, reach, parent, outerScheme, outerAlternations]);
  if (value !== null && value.alternations > MAX_SCHEME_ALTERNATIONS) {
    throw new Error(
      `[theme-boundary] colour schemes alternate ${value.alternations} times here (light/dark/light/…); the nearest-carrier selector resolves ${MAX_SCHEME_ALTERNATIONS} (ui-kit core's DARK_SCHEME).`,
    );
  }
  return (
    <PortalForwardProvider
      name={COLOR_SCHEME_ATTR}
      value={scheme}
      reach={reach}
    >
      <ColorSchemeContext.Provider value={value}>
        {children}
      </ColorSchemeContext.Provider>
    </PortalForwardProvider>
  );
}
