import type { InstallCapabilities } from "../../core";

/** What the capability answer is derived from — probed once per process. */
export interface CapabilityProbe {
  platform: NodeJS.Platform;
  /**
   * Linux: did `gsettings get org.gnome.shell favorite-apps` answer? That is
   * the GNOME Shell schema being installed and the session bus reachable —
   * the two things a dash pin needs. (Read rather than `XDG_CURRENT_DESKTOP`,
   * which a backend spawned by a user service does not inherit.)
   */
  gnomeFavorites: boolean;
}

/**
 * What this host can do with an app shim. macOS: install and Dock pin.
 * Linux: install (a freedesktop desktop entry every XDG launcher reads), pin
 * only on GNOME. Anything else: neither — the panel hides the + rather than
 * offering an install that cannot work.
 */
export function installCapabilities(
  probe: CapabilityProbe,
): InstallCapabilities {
  if (probe.platform === "darwin") {
    return { platform: "macos", install: true, pin: true, reason: null };
  }
  if (probe.platform === "linux") {
    return probe.gnomeFavorites
      ? { platform: "linux", install: true, pin: true, reason: null }
      : {
          platform: "linux",
          install: true,
          pin: false,
          reason:
            "Pinning needs GNOME Shell's dash (gsettings org.gnome.shell favorite-apps); installed apps appear in the launcher only.",
        };
  }
  return {
    platform: "other",
    install: false,
    pin: false,
    reason: `Installing apps is supported on macOS and Linux, not on ${probe.platform}.`,
  };
}
