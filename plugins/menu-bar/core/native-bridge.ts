import { z } from "zod";

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
  /**
   * This helper keeps the device's installed apps (`apps`, `pinApp`): the
   * main instance's tray. Installing is the helper's power, never the
   * server's.
   */
  apps: boolean;
  /** It can keep an app in the Dock (macOS) / GNOME dash (Linux). */
  pin: boolean;
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

/** `apps()`'s answer: the apps installed as OS apps, and those pinned. */
export interface NativeApps {
  installed: string[];
  pinned: string[];
}

export const NativeAppsSchema: z.ZodType<NativeApps> = z.object({
  installed: z.array(z.string()),
  pinned: z.array(z.string()),
});

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
  /** The installed and pinned apps (after the sync the panel's load started). */
  apps?(): Promise<unknown>;
  /** Keep an app in the Dock / dash; resolves once it is pinned. */
  pinApp?(appId: string): Promise<void>;
}

/**
 * The method names {@link EquinNativeBridge} must carry, checked at the
 * boundary. `apps` / `pinApp` are checked only when `hostInfo()` says the
 * helper keeps apps (a helper built before them has neither).
 */
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
export const NativeHostInfoSchema: z.ZodType<NativeHostInfo> = z.object({
  version: z.literal(1),
  platform: z.enum(["macos", "linux"]),
  capabilities: z.object({
    notify: z.boolean(),
    attention: z.boolean(),
    launchApp: z.boolean(),
    openUrl: z.boolean(),
    // Absent from a helper built before it installed apps itself: it keeps
    // none.
    apps: z.boolean().default(false),
    pin: z.boolean().default(false),
  }),
  // Absent from a helper built before the material existed (an installed
  // binary outlives the web it was built beside): that window is the opaque
  // square one, so it reads as `null`.
  material: z
    .object({ cornerRadius: z.number().positive() })
    .nullable()
    .default(null),
});
