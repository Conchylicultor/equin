import { exists, readdir } from "@plugins/packages/plugins/timed-fs/core";

/**
 * Whether this machine has a desktop a `graphical` login service can show on:
 * `{ desktop: true }`, or `{ desktop: false, why, evidence }` — `why` in a
 * person's words (what `start` prints when it leaves such a service out),
 * `evidence` the raw facts.
 *
 * - macOS: always (a LaunchAgent in the Aqua session; with nobody logged in,
 *   it waits for the next login).
 * - Linux: a display in this environment (`DISPLAY` / `WAYLAND_DISPLAY`, not
 *   over SSH, where `ssh -X` sets one on a server), or a desktop installed —
 *   a display manager enabled (systemd's `display-manager.service` alias) or a
 *   desktop session to log into (`/usr/share/xsessions`,
 *   `/usr/share/wayland-sessions`). So an install over SSH onto a desktop
 *   machine still adds it for the next login, while a headless server never
 *   builds or registers one. NOT `systemctl get-default`: Ubuntu Server and
 *   cloud images boot `graphical.target` with no desktop at all.
 */
export type HostDesktop =
  | { readonly desktop: true }
  | {
      readonly desktop: false;
      readonly why: string;
      readonly evidence: string;
    };

const DISPLAY_MANAGER = "/etc/systemd/system/display-manager.service";
const SESSION_DIRS = ["/usr/share/xsessions", "/usr/share/wayland-sessions"];

export async function hostDesktop(): Promise<HostDesktop> {
  if (process.platform !== "linux") return { desktop: true };
  const overSsh = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
  if (!overSsh && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY))
    return { desktop: true };
  if (await exists(DISPLAY_MANAGER)) return { desktop: true };
  for (const dir of SESSION_DIRS) {
    if (!(await exists(dir))) continue;
    if ((await readdir(dir)).some((f) => f.endsWith(".desktop")))
      return { desktop: true };
  }
  return {
    desktop: false,
    why: "this computer has no desktop to show it on",
    evidence: `no display${overSsh ? " outside SSH" : ""}, no ${DISPLAY_MANAGER}, no session in ${SESSION_DIRS.join(" or ")}`,
  };
}
