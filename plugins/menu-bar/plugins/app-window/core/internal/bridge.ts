import { z } from "zod";

/**
 * What an installed app's window (the native helper's window mode,
 * `menu-bar/rust/src/window.rs`) can do on this machine. A capability the
 * platform lacks is `false`, and the page keeps its plain web behaviour.
 */
export const AppWindowInfoSchema = z.object({
  version: z.literal(1),
  platform: z.enum(["macos", "linux"]),
  capabilities: z.object({
    /** `startFileDrag`: dragging host paths out as real files (macOS). */
    fileDrag: z.boolean(),
  }),
});

export type AppWindowInfo = z.infer<typeof AppWindowInfoSchema>;

/**
 * How a native file drag ended: something took the drop (a copy — the drag
 * never moves the user's file away), or nothing did (released elsewhere, Esc,
 * or the button was already up when the drag would have started).
 */
export const FileDragOutcomeSchema = z.enum(["dropped", "cancelled"]);

export type FileDragOutcome = z.infer<typeof FileDragOutcomeSchema>;

/**
 * The bridge the helper injects as `window.equinWindow` — in an installed
 * app's window only, on its own origin's pages, main frame only
 * (`rust/src/window_bridge.js`). Every method is asynchronous IPC.
 */
export interface EquinWindowBridge {
  hostInfo(): Promise<unknown>;
  /**
   * Drag `paths` (absolute, existing) as real files, starting under the
   * pointer — called from a `dragstart` whose browser drag is cancelled.
   * Resolves once the drag ends.
   */
  startFileDrag(paths: readonly string[]): Promise<unknown>;
}

/** The method names {@link EquinWindowBridge} must carry, checked at the boundary. */
export const WINDOW_BRIDGE_METHODS = [
  "hostInfo",
  "startFileDrag",
] as const satisfies readonly (keyof EquinWindowBridge)[];
