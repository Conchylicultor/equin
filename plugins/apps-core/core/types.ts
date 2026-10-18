import type { ReactNode } from "react";

/**
 * The pieces the app-rail framing variant lays out. A rail variant owns the
 * outer flex wrapper, sets the `--app-rail-width` CSS var (the rail's own
 * width), optionally renders the rail, and places `body` (the active app's
 * isolated subtree) beside it. `body` starts after the rail purely by virtue of
 * the flex layout, so the app shell's sidebar — fixed but bounded to `body` —
 * pins to `body`'s left edge with no extra offset.
 *
 * Owned by `apps` (the host) so the contract lives with the consumer, and a
 * rail-framing plugin can contribute a variant without `apps` ever importing a
 * specific one. Mirrors `SidebarFramingProps` in app-shell/core.
 */
export interface RailFramingProps {
  /** The active app's content subtree (already wrapped in PaneBasePathContext). */
  body: ReactNode;
  /**
   * False while the surface mode draws its own frame (solo, the desktop): a
   * variant then renders no rail, but keeps `body` at the SAME position in the
   * tree — `{showRail ? <Rail/> : null}`, never a different wrapper — because
   * `body` holds every keep-alive tab, and a re-parented body remounts them all.
   */
  showRail: boolean;
}

/**
 * The surface rendering mode — a SINGLE per-surface value (docked / windows /
 * solo), never per-tab. The surface renders every open tab under this one mode,
 * so the modes are mutually exclusive by construction: "tabs" (docked), "desktop"
 * (windows), and "full app" (solo) can never be visible at the same time. This
 * is what makes a solo app and a floating window overlapping structurally
 * unrepresentable — there is no per-tab placement that could disagree with the
 * mode.
 *
 * A mode is an **opaque id** owned by the `surface` registry — each mode is a
 * self-contained sub-plugin contributing a descriptor under the
 * `Surface.Placement` slot, and the id is whatever that descriptor declares.
 * `apps` stores the current mode + routes mode changes, but never enumerates the
 * valid set and never knows the default: those live in the `surface` registry,
 * surfaced back to `apps` through the apps-owned capability registry. Keeping it
 * a named alias (rather than bare `string`) documents the intent at call sites.
 * All *presentation* lives in the mode sub-plugins, never here.
 */
export type Placement = string;
