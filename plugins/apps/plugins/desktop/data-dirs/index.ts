import { defineAppDataDir } from "@plugins/infra/plugins/paths/core";
import { desktopApp } from "@plugins/apps/plugins/desktop/plugins/shell/core";

/**
 * The desktop app's one data dir, `apps/desktop`. Each sub-plugin takes an area
 * inside it with `desktopDir.subdir("<area>")` rather than a dir of its own.
 * Today the one area is `wallpaper/` (the current uploaded image and its
 * sidecar), whose only copy is the file the user uploaded — which is why an app
 * dir is never reclaimable.
 *
 * `movedFrom`: the wallpaper used to be its own top-level app dir,
 * `apps/wallpaper`, declared by the wallpaper sub-plugin as if it were an app.
 * The declaration records that, so the move is performed by the paths
 * primitive rather than a one-off script: until the host's singleton process
 * (main) has moved the bytes into `apps/desktop/wallpaper` — leaving a symlink
 * at the old name for older checkouts — every other process keeps resolving
 * the old location. A worktree build of this change therefore touches nothing
 * on the shared root.
 */
export const desktopDir = defineAppDataDir(desktopApp, {
  owner: "apps/desktop",
  description:
    "The desktop app's host-global data — currently the uploaded wallpaper image and its mime/version sidecar",
  movedFrom: [{ from: "apps/wallpaper", to: "wallpaper" }],
});

export default [desktopDir];
