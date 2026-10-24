import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import type { BuildContext } from "@plugins/infra/plugins/deps/plugins/build/deps";
import { cargoBuild } from "@plugins/infra/plugins/deps/plugins/rust/deps";

const CRATE = "plugins/menu-bar/rust";
const BIN = "equin-desktop";
const APP = "equin.app";
/** The bundle identity macOS files the helper's notifications under (= tauri.conf.json's identifier). */
const BUNDLE_ID = "dev.equin.menu-bar";
const MINUTE = 60_000;

/**
 * `Info.plist` of the helper's bundle: `LSUIElement` keeps it out of the Dock
 * and the app switcher (the status item is its only presence). The ATS
 * exception lets its webview load `http://<ns>.localhost:9000` — inside a
 * bundle, App Transport Security otherwise blocks plain-http loads (the
 * navigation starts and never commits); `NSAllowsLocalNetworking` does not
 * cover `*.localhost`.
 */
function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>equin</string>
  <key>CFBundleDisplayName</key><string>equin</string>
  <key>CFBundleExecutable</key><string>${BIN}</string>
  <key>CFBundleIconFile</key><string>equin</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSExceptionDomains</key>
    <dict>
      <key>localhost</key>
      <dict>
        <key>NSIncludesSubdomains</key><true/>
        <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
      </dict>
    </dict>
  </dict>
</dict>
</plist>
`;
}

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
 * Assemble `equin.app` around the built binary: the binary (copied — `built`
 * is the shared target dir's), `Info.plist`, the spiral as `equin.icns`
 * (`sips` + `iconutil` over the crate's build-rendered `icons/icon.png`), then
 * an ad-hoc signature (`codesign -s -`) so the bundle has a stable identity.
 */
async function assembleApp(ctx: BuildContext, built: string): Promise<void> {
  const env = { ...process.env };
  const contents = join(ctx.output, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });

  copyFileSync(built, join(macos, BIN));
  chmodSync(join(macos, BIN), 0o755);
  writeFileSync(join(contents, "Info.plist"), infoPlist());

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
    ["iconutil", "-c", "icns", iconset, "-o", join(resources, "equin.icns")],
    { cwd: ctx.dir, env, timeoutMs: MINUTE },
  );
  rmSync(scratch, { recursive: true });

  await ctx.run(["codesign", "--force", "--sign", "-", ctx.output], {
    cwd: ctx.dir,
    env,
    timeoutMs: MINUTE,
  });
}

/**
 * The native helper — `equin-desktop` (rust/): the menu-bar / top-bar icon and
 * its panel (`tray`), and an installed app's window (`window`). Built from this
 * checkout's crate by the rust kind. macOS: `equin.app` (a bundle identity for
 * notifications, no Dock icon); Linux: the bare binary.
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
          output: APP,
          binary: `${APP}/Contents/MacOS/${BIN}`,
          then: assembleApp,
        })
      : cargoBuild({ crate: CRATE, bin: BIN }),
  updates: { none: "built from this checkout's own source" },
});
