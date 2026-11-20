import type { ComponentType } from "react";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import type { AppIcon } from "@plugins/apps-core/plugins/app-icon/core";

// The `Apps.App` list's entry, owned here (core) rather than beside the slot
// (web) so the server — which reads the list's facts from the list catalog
// (`declaredApps`) — names the same type the browser registers.

/**
 * What picking an app does — exactly one of two, so an entry can never both
 * open a tab and switch the surface:
 *
 *  - `component` — the app's layout: picking it opens (or swaps in) a tab
 *    showing it, at its base path. Every regular app.
 *  - `surfaceMode` — a surface-mode app (the desktop): picking it switches the
 *    surface to that `Surface.Placement` id. It never becomes a tab —
 *    {@link isTabApp} keeps it out of URL matching and the tab set — and its
 *    URL is its base path as a route PREFIX, written in front of the focused
 *    tab's own URL while its mode shows (`/desktop/agents/c/42`). It is still
 *    an app: listed in the launchers, installable, and given its own
 *    `app:<id>` theme and config scope like any other.
 */
export type AppLaunch =
  | { component: ComponentType; surfaceMode?: never }
  | { surfaceMode: string; component?: never };

/**
 * One installed app, as its shell authors it. The app's identity — id, base
 * path, display name, icon and its colour — is authored ONCE via `defineApp` in
 * the shell's `core/`, and handed here whole as {@link AppRef}. The contribution
 * restates none of it, so the two can never disagree.
 */
interface AppEntryBase {
  /** The app itself (`defineApp(…)` from the shell's `core/app.ts`). */
  app: AppRef;
  /** The app's brand mark — the icon heading its own chrome (the app
   * launcher's button). Omitted, the launcher draws {@link AppEntry.icon}. For an app
   * whose identity is a drawn logo rather than a glyph. */
  mark?: ComponentType<{ className?: string }>;
  /** The name heading the app's sidebar (the brand's `header` form), drawn
   * whole — text, typography and its own loading state. Omitted, the brand
   * prints {@link AppRef.name}. For an app whose sidebar is named after what it
   * holds rather than what it is ("Jane's pages"). */
  brandName?: ComponentType;
  /** Optional overlay rendered on the app's rail icon (e.g. an attention
   * dot). Painted at the icon's top-right corner; render `null` when there's
   * nothing to surface so the corner stays empty. */
  badge?: ComponentType<{ className?: string }>;
}

/** What a shell hands `Apps.App`: the app and how it launches — no icon. */
export type AppEntrySpec = AppEntryBase & AppLaunch;

/**
 * One installed app, as its readers see it: the authored {@link AppEntrySpec}
 * plus its canonical icon descriptor, DERIVED from `app.icon` / `app.iconColor`
 * by `Apps.App` — so no shell can draw an icon its `defineApp` does not name.
 */
export type AppEntry = AppEntrySpec & {
  /** The app's canonical serializable icon descriptor (see {@link AppIcon}). */
  icon: AppIcon;
};
