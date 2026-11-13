// The menu-bar helper as a per-user login service: `./equin start` registers
// it next to the gateway (ensuring and holding `menu-bar-helper` from the main
// checkout), so the equin icon is in the menu bar / top bar after every login,
// and relaunched if it dies. `graphical`: it needs the desktop session.
import { userInfo } from "node:os";
import { HOME_DIR } from "@plugins/infra/plugins/paths/plugins/data-root-layout/core";
import { defineLoginService } from "@plugins/infra/plugins/launcher/plugins/login-services/machine";
import { GATEWAY_SERVICE } from "@plugins/infra/plugins/launcher/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { cargoBinary } from "@plugins/infra/plugins/deps/plugins/rust/deps";
import { componentIdentity } from "@plugins/infra/plugins/launcher/plugins/login-services/core";
import type { BundleSigner } from "@plugins/infra/plugins/codesign/deps";
import { OPEN_LINK_SCHEME } from "../core";
import { menuBarHelper, menuBarHelperIcon } from "../deps";
import { menuBarLogs } from "../data-dirs";

/**
 * The environment the tray runs with — the whole of it (nothing is
 * inherited). `gatewayLabel`: the label the gateway's service is bound to on
 * this machine (`refersTo`). `signer`: how the tray signs the installed apps'
 * shims (src/apps.rs) — with the machine's identity, the one `equin.app` is
 * signed with, so a folder grant to an app survives a new helper; null off
 * macOS, where nothing is signed.
 */
function trayEnv(
  gatewayLabel: string,
  signer: BundleSigner | null,
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: HOME_DIR,
    USER: userInfo().username,
    // `open` / `xdg-open` (openUrl) and `launchctl` / `systemctl` (Start).
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    // Start kicks the gateway's service by the label it is bound to here —
    // the old one until `./equin data-dir migrate` relabels it — so a
    // relabel rewrites (and reloads) this job too.
    ...envEntries({ GATEWAY_LABEL: gatewayLabel }),
    ...(signer === null
      ? {}
      : envEntries({
          SHIM_SIGNER: JSON.stringify({
            sha1: signer.sha1,
            sign: signer.sign,
            verify: signer.verify,
          }),
        })),
  };
  // A graphical systemd unit inherits the session's display from the user
  // manager's environment; these carry it when `start` itself has them.
  for (const key of [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export const menuBarService = defineLoginService({
  id: "dev.equin.menu-bar",
  owner: "companions/menu-bar",
  description:
    "equin menu-bar helper (the equin icon in the menu bar / top bar)",
  session: "graphical",
  dep: menuBarHelper,
  // The equin app's main executable on macOS: what notifications (and
  // `Bundle.main`) see, and what opening equin.app runs.
  executable: {
    name: "equin-desktop",
    main: true,
    // A browser tab's "Open in app window" (`equin://open?url=…`): macOS
    // hands the link to the running tray (`rust/src/open_link.rs`).
    urlSchemes: [OPEN_LINK_SCHEME],
    build: (ready) => {
      const icon = menuBarHelperIcon(ready);
      return {
        file: cargoBinary(ready),
        ...(icon === null ? {} : { icon }),
        identity: componentIdentity(menuBarHelper.id, ready.identity),
      };
    },
  },
  // Start kicks the gateway's service: its bound label is part of the job.
  refersTo: { gateway: GATEWAY_SERVICE },
  spec: (ready, executable, labels, signer) => ({
    // Inside equin.app on macOS (so notifications carry the app's identity),
    // the bare binary on Linux.
    argv: [executable, "tray"],
    cwd: ready.dir,
    env: trayEnv(labels.gateway, signer),
    stdioLog: menuBarLogs.file("helper-stdio.log"),
  }),
});

export default [menuBarService];
