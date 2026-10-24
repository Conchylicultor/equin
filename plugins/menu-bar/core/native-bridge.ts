import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";

/**
 * What the native helper (`menu-bar/rust`, the `equin-desktop` tray) can do on
 * this machine. A capability the platform lacks is `false`, and the panel hides
 * the UI that would use it — never fakes it.
 */
export interface NativeCapabilities {
  /** Native OS notifications (needs the helper's bundle id on macOS). */
  notify: boolean;
  /** The attention dot on the menu-bar icon. */
  attention: boolean;
  /** Launching an installed app's own window. */
  launchApp: boolean;
  /** Opening a URL in the default browser. */
  openUrl: boolean;
}

/**
 * The panel window is a transparent system material (macOS vibrancy) clipped
 * to rounded corners: the page paints no opaque background of its own, tints
 * the material with a translucent fill, and rounds its content to
 * `cornerRadius` (CSS px) — the window's own corner radius.
 */
export interface NativeMaterial {
  cornerRadius: number;
}

/** `hostInfo()`'s answer: the bridge's version, the OS and its capabilities. */
export interface NativeHostInfo {
  version: 1;
  platform: "macos" | "linux";
  capabilities: NativeCapabilities;
  /** `null`: an opaque square window (Linux, or a helper that predates the
   *  material). */
  material: NativeMaterial | null;
}

/** One native notification. `tag` coalesces notifications sharing it. */
export interface NativeNotification {
  title: string;
  body?: string;
  tag?: string;
}

/**
 * The bridge the native helper injects as `window.equinNative` — in its panel
 * window only (app windows and other origins get none). The helper implements
 * exactly this; every method is asynchronous IPC.
 */
export interface EquinNativeBridge {
  hostInfo(): Promise<unknown>;
  setAttention(on: boolean): Promise<void>;
  notify(notification: NativeNotification): Promise<void>;
  openUrl(url: string): Promise<void>;
  launchApp(appId: string): Promise<void>;
  hidePanel(): Promise<void>;
  setPanelHeight(px: number): Promise<void>;
}

/** The method names {@link EquinNativeBridge} must carry, checked at the boundary. */
export const BRIDGE_METHODS = [
  "hostInfo",
  "setAttention",
  "notify",
  "openUrl",
  "launchApp",
  "hidePanel",
  "setPanelHeight",
] as const satisfies readonly (keyof EquinNativeBridge)[];

/** Parses `hostInfo()`'s untrusted answer: anything else is a broken bridge. */
export const NativeHostInfoSchema: ZodParser<NativeHostInfo> = z.object({
  version: z.literal(1),
  platform: z.enum(["macos", "linux"]),
  capabilities: z.object({
    notify: z.boolean(),
    attention: z.boolean(),
    launchApp: z.boolean(),
    openUrl: z.boolean(),
  }),
  // Absent from a helper built before the material existed (an installed
  // binary outlives the web it was built beside): that window is the opaque
  // square one, so it reads as `null`.
  material: z
    .object({ cornerRadius: z.number().positive() })
    .nullable()
    .default(null),
});
