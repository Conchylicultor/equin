// The menu-bar helper as a per-user login service: `./equin start` registers
// it next to the gateway (ensuring and holding `menu-bar-helper` from the main
// checkout), so the equin icon is in the menu bar / top bar after every login,
// and relaunched if it dies. `graphical`: it needs the desktop session.
import { userInfo } from "node:os";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { defineLoginService } from "@plugins/infra/plugins/launcher/plugins/login-services/machine";
import { cargoBinary } from "@plugins/infra/plugins/deps/plugins/rust/deps";
import { menuBarHelper } from "../deps";
import { menuBarLogs } from "../data-dirs";

/** The environment the tray runs with — the whole of it (nothing is inherited). */
function trayEnv(): Record<string, string> {
  const env: Record<string, string> = {
    HOME: HOME_DIR,
    USER: userInfo().username,
    // `open` / `xdg-open` (openUrl) and `launchctl` / `systemctl` (Start).
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
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
  owner: "menu-bar",
  description:
    "equin menu-bar helper (the equin icon in the menu bar / top bar)",
  session: "graphical",
  dep: menuBarHelper,
  spec: (ready) => ({
    // The binary inside equin.app on macOS (so notifications carry the
    // bundle's identity), the bare binary on Linux.
    argv: [cargoBinary(ready), "tray"],
    cwd: ready.dir,
    env: trayEnv(),
    stdioLog: menuBarLogs.file("helper-stdio.log"),
  }),
});

export default [menuBarService];
