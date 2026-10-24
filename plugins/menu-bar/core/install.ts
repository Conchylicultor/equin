import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/** What every install read and write needs: the shims live on this computer. */
const INSTALL_MACHINE = { feature: "Installing apps" } as const;

/**
 * `POST /api/menu-bar/install/:appId` — install a tab app as an OS app of its
 * own: a launcher shim (macOS `~/Applications/equin <Name>.app`, Linux a
 * `.desktop` entry) running the native helper's window mode on the app's URL,
 * pinned to the Dock / GNOME dash where the host can.
 *
 * - `installed` — the shim is written (and pinned where `capabilities.pin`).
 * - `waiting-for-helper` — the native helper (`menu-bar-helper`) is not built
 *   yet: its install was requested, and the app is installed when it lands
 *   (`menu-bar.install-requests` carries the pending row, then the failure if
 *   the build fails).
 *
 * An unknown or unlisted app is a 404; a host without the capability a 409.
 */
export const installApp = defineEndpoint({
  route: "POST /api/menu-bar/install/:appId",
  response: z.object({ status: z.enum(["installed", "waiting-for-helper"]) }),
  needsMachine: INSTALL_MACHINE,
});

/** The apps installed as OS apps — read from the shims on disk. */
export const InstalledAppsSchema = z.object({
  appIds: wholeList(z.string(), {
    reason:
      "one id per app installed as an OS app — bounded by the apps there are",
  }),
});
export type InstalledApps = z.infer<typeof InstalledAppsSchema>;

/**
 * Which apps have a launcher shim on this computer, read from the shim
 * directories themselves (so a shim deleted in Finder disappears here too).
 * Recomputed by the install endpoint and by a watch of the shim directories.
 */
export const menuBarInstalled = liveValue("menu-bar.installed", {
  schema: InstalledAppsSchema,
  needsMachine: INSTALL_MACHINE,
});

/**
 * An install the endpoint accepted but could not finish yet: waiting for the
 * native helper's build, or failed (the helper's build, or writing the shim
 * once it landed). A finished install leaves the list.
 */
export const InstallRequestSchema = z.discriminatedUnion("state", [
  z.object({ appId: z.string(), state: z.literal("waiting-for-helper") }),
  z.object({
    appId: z.string(),
    state: z.literal("failed"),
    message: z.string(),
  }),
]);
export type InstallRequest = z.infer<typeof InstallRequestSchema>;

export const InstallRequestsSchema = z.object({
  requests: wholeList(InstallRequestSchema, {
    reason:
      "at most one in-flight or failed install per app — bounded by the apps there are",
  }),
});
export type InstallRequests = z.infer<typeof InstallRequestsSchema>;

/** The installs in flight or failed, this backend's (in memory). */
export const menuBarInstallRequests = liveValue("menu-bar.install-requests", {
  schema: InstallRequestsSchema,
  needsMachine: INSTALL_MACHINE,
});

/**
 * What this host can do with an app shim:
 *
 * - `install` — write a launcher shim (macOS: always; Linux: an XDG desktop
 *   with `~/.local/share/applications`, i.e. any freedesktop session).
 * - `pin` — keep it in the Dock (macOS) / the GNOME dash (`gsettings
 *   org.gnome.shell favorite-apps`). Other Linux desktops: launcher entry only.
 *
 * `reason` says why a capability is missing, in the user's words.
 */
export const InstallCapabilitiesSchema = z.object({
  platform: z.enum(["macos", "linux", "other"]),
  install: z.boolean(),
  pin: z.boolean(),
  reason: z.string().nullable(),
});
export type InstallCapabilities = z.infer<typeof InstallCapabilitiesSchema>;

export const menuBarCapabilities = liveValue("menu-bar.capabilities", {
  schema: InstallCapabilitiesSchema,
  needsMachine: INSTALL_MACHINE,
});
