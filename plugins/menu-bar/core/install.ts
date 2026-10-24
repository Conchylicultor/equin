import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

/** What every install read and write needs: the shims live on this computer. */
const INSTALL_MACHINE = { feature: "Installing apps" } as const;

/**
 * `POST /api/menu-bar/pin/:appId` — keep an app in the Dock / GNOME dash.
 * Every app already has its launcher shim (macOS `~/Applications/equin
 * <Name>.app`, Linux a `.desktop` entry), kept by main ahead of any click;
 * the endpoint writes it first when it is not there yet.
 *
 * - `pinned` — the shim is in the Dock / dash.
 * - `waiting-for-helper` — the native helper (`menu-bar-helper`) is not built
 *   yet: its install was requested, and the app is pinned when it lands
 *   (`menu-bar.pin-requests` carries the pending row, then the failure if the
 *   build fails).
 *
 * An unknown or unlisted app is a 404; a host that cannot pin a 409.
 */
export const pinApp = defineEndpoint({
  route: "POST /api/menu-bar/pin/:appId",
  response: z.object({ status: z.enum(["pinned", "waiting-for-helper"]) }),
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
 * Recomputed by main's shim sync, the pin endpoint and a watch of the shim
 * directories.
 */
export const menuBarInstalled = liveValue("menu-bar.installed", {
  schema: InstalledAppsSchema,
  needsMachine: INSTALL_MACHINE,
});

/**
 * Which apps the Dock (macOS) / GNOME dash (Linux) keeps — read from the
 * Dock's preferences / the dash's favorites, matched against the shims.
 * Recomputed by the pin endpoint and by a watch of that store, so an app
 * dragged out of the Dock leaves it. Empty where the host cannot pin.
 */
export const menuBarPinned = liveValue("menu-bar.pinned", {
  schema: InstalledAppsSchema,
  needsMachine: INSTALL_MACHINE,
});

/**
 * A pin the endpoint accepted but could not finish yet: waiting for the
 * native helper's build, or failed (the helper's build, writing the shim once
 * it landed, or the pin itself). A finished pin leaves the list.
 */
export const PinRequestSchema = z.discriminatedUnion("state", [
  z.object({ appId: z.string(), state: z.literal("waiting-for-helper") }),
  z.object({
    appId: z.string(),
    state: z.literal("failed"),
    message: z.string(),
  }),
]);
export type PinRequest = z.infer<typeof PinRequestSchema>;

export const PinRequestsSchema = z.object({
  requests: wholeList(PinRequestSchema, {
    reason:
      "at most one in-flight or failed pin per app — bounded by the apps there are",
  }),
});
export type PinRequests = z.infer<typeof PinRequestsSchema>;

/** The pins in flight or failed, this backend's (in memory). */
export const menuBarPinRequests = liveValue("menu-bar.pin-requests", {
  schema: PinRequestsSchema,
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
