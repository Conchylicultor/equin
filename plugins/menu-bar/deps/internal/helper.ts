import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDep, type Ready } from "@plugins/infra/plugins/deps/deps";
import type { BuildContext } from "@plugins/infra/plugins/deps/plugins/build/deps";
import {
  cargoBuild,
  type CargoSource,
} from "@plugins/infra/plugins/deps/plugins/rust/deps";

const CRATE = "plugins/menu-bar/rust";
const BIN = "equin-desktop";
/** macOS: the binary and the app icon, side by side — what the equin app bundle installs. */
const MACOS = "macos";
/** The app icon, built from the crate's spiral (`.icns`, for the equin app bundle). */
const ICON = "equin.icns";
const MINUTE = 60_000;

/** The `.iconset` sizes `iconutil` reads, from the 512 px icon build.rs renders. */
const ICONSET: ReadonlyArray<readonly [name: string, px: number]> = [
  ["icon_16x16", 16],
  ["icon_16x16@2x", 32],
  ["icon_32x32", 32],
  ["icon_32x32@2x", 64],
  ["icon_128x128", 128],
  ["icon_128x128@2x", 256],
  ["icon_256x256", 256],
  ["icon_256x256@2x", 512],
  ["icon_512x512", 512],
];

/**
 * macOS: the binary (copied — `built` is the shared target dir's) and the
 * spiral as `equin.icns` (`sips` + `iconutil` over the crate's build-rendered
 * `icons/icon.png`). No bundle: the helper runs from the ONE equin app bundle
 * every login service shares (login-services' `macos-app`), which installs
 * both and signs the whole with the machine's identity.
 */
async function assembleMacos(ctx: BuildContext, built: string): Promise<void> {
  const env = { ...process.env };
  mkdirSync(ctx.output, { recursive: true });
  copyFileSync(built, join(ctx.output, BIN));
  chmodSync(join(ctx.output, BIN), 0o755);

  // The iconset is scratch, outside env/.
  const scratch = mkdtempSync(join(tmpdir(), "equin-iconset-"));
  const iconset = join(scratch, "equin.iconset");
  mkdirSync(iconset);
  const source = join(ctx.root, CRATE, "icons", "icon.png");
  for (const [name, px] of ICONSET) {
    await ctx.run(
      [
        "sips",
        "-z",
        String(px),
        String(px),
        source,
        "--out",
        join(iconset, `${name}.png`),
      ],
      { cwd: ctx.dir, env, timeoutMs: MINUTE },
    );
  }
  await ctx.run(
    ["iconutil", "-c", "icns", iconset, "-o", join(ctx.output, ICON)],
    { cwd: ctx.dir, env, timeoutMs: MINUTE },
  );
  rmSync(scratch, { recursive: true });
}

/** The app icon of an installed macOS build (see {@link assembleMacos}); null on Linux. */
export function menuBarHelperIcon(ready: Ready<CargoSource>): string | null {
  return process.platform === "darwin" ? join(ready.dir, MACOS, ICON) : null;
}

/**
 * The native helper — `equin-desktop` (rust/): the menu-bar / top-bar icon and
 * its panel (`tray`), and an installed app's window (`window`). Built from this
 * checkout's crate by the rust kind. macOS: the binary beside the app icon,
 * which the equin app bundle installs (its notifications are the app's);
 * Linux: the bare binary.
 */
export const menuBarHelper = defineDep({
  id: "menu-bar-helper",
  owner: "menu-bar",
  description:
    "The native menu-bar helper (equin-desktop): the equin icon in the macOS menu bar / Linux top bar and the panel it opens",
  sizeHint: "≈6 MB",
  source:
    process.platform === "darwin"
      ? cargoBuild({
          crate: CRATE,
          bin: BIN,
          output: MACOS,
          binary: `${MACOS}/${BIN}`,
          then: assembleMacos,
        })
      : cargoBuild({ crate: CRATE, bin: BIN }),
  updates: { none: "built from this checkout's own source" },
});
