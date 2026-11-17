import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { cargoBuild } from "@plugins/infra/plugins/deps/plugins/rust/deps";
import { PAGE_SOURCES, writePage } from "./page";

/**
 * The installer window, `equin-installer` (rust/): built from this checkout's
 * crate with its page bundled in. The release pipeline (a later task) builds
 * the same crate per release tag for the curl install; this local build is
 * what `./equin installer window` runs, and what a developer tries the window
 * with.
 */
export const installerWindow = defineDep({
  id: "installer-window",
  owner: "installer/window",
  description:
    "The equin installer window (equin-installer): runs install.sh and shows its progress",
  sizeHint: "≈3 MB",
  source: cargoBuild({
    crate: "plugins/installer/plugins/window/rust",
    bin: "equin-installer",
    embed: {
      // The page, the protocol it draws, and the npm code bundled with it.
      inputs: [`${PAGE_SOURCES}/**`, "plugins/installer/core/**", "bun.lock"],
      build: (ctx, scratch) => writePage(ctx.root, scratch),
    },
  }),
  updates: { none: "built from this checkout's own source" },
});
