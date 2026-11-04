import { defineFileRoot } from "@plugins/infra/plugins/paths/plugins/data-files/server";

/**
 * The desktop app's data dir, `apps/desktop`, as a file root: the wallpaper's
 * area is `wallpaper/` in it. The computer's disk on the desktop (bound by
 * this plugin's `machine/`), memory in a browser host — where an uploaded
 * wallpaper lasts as long as the session.
 */
export const desktopFiles = defineFileRoot({
  id: "apps.desktop.wallpaper",
  dir: "apps/desktop",
});
