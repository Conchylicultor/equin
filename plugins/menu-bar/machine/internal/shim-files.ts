import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The shim contract, as pure data: where an installed app's launcher lives and
 * what its files say. The Rust helper (`rust/`) reads a shim exactly so — on
 * macOS its own bundle's `Info.plist` (`EquinAppId`, `EquinUrl`), on Linux its
 * argv (`window --app <id> --url <url>`) — so neither side may change a name
 * here alone.
 */

/** The helper's executable name, inside every shim bundle. */
export const SHIM_EXECUTABLE = "equin-desktop";
/** A macOS shim bundle's name prefix: `equin <Name>.app`. */
const MAC_BUNDLE_PREFIX = "equin ";
/** A Linux shim's file stem prefix: `equin-<appId>`. */
const LINUX_PREFIX = "equin-";

/** The app a shim opens, as the shim spells it. */
export interface ShimApp {
  id: string;
  name: string;
  /** The app's absolute URL (`http://singularity.localhost:9000/mail`). */
  url: string;
  /** The namespace the URL is on. */
  namespace: string;
}

/** The two roots shims are written under (both injectable, for tests). */
export interface ShimRoots {
  /** macOS: the user's Applications folder (`~/Applications`). */
  macApplications: string;
  /** Linux: the XDG data home (`~/.local/share`). */
  xdgDataHome: string;
}

/** The home-relative defaults of {@link ShimRoots}. */
export function defaultShimRoots(home: string): ShimRoots {
  return {
    macApplications: join(home, "Applications"),
    xdgDataHome: join(home, ".local", "share"),
  };
}

export type ShimPlatform = "macos" | "linux";

/** A macOS shim's bundle path, its `Contents/` files, and its bundle id. */
export function macShimPaths(roots: ShimRoots, app: Pick<ShimApp, "name">) {
  const bundle = join(
    roots.macApplications,
    `${MAC_BUNDLE_PREFIX}${app.name}.app`,
  );
  const contents = join(bundle, "Contents");
  return {
    bundle,
    executable: join(contents, "MacOS", SHIM_EXECUTABLE),
    infoPlist: join(contents, "Info.plist"),
    icns: join(contents, "Resources", "app.icns"),
  };
}

/** A Linux shim's desktop entry and icon paths. */
export function linuxShimPaths(roots: ShimRoots, appId: string) {
  return {
    desktopFile: join(
      linuxApplicationsDir(roots),
      `${LINUX_PREFIX}${appId}.desktop`,
    ),
    icon: join(
      roots.xdgDataHome,
      "icons",
      "hicolor",
      "512x512",
      "apps",
      `${LINUX_PREFIX}${appId}.png`,
    ),
  };
}

/** The directory a host's shims live in — what the installed set reads and watches. */
export function shimDir(platform: ShimPlatform, roots: ShimRoots): string {
  return platform === "macos"
    ? roots.macApplications
    : linuxApplicationsDir(roots);
}

function linuxApplicationsDir(roots: ShimRoots): string {
  return join(roots.xdgDataHome, "applications");
}

/** The bundle identifier of an app's macOS shim. */
export function shimBundleId(appId: string): string {
  return `dev.equin.app.${appId}`;
}

/** The desktop-file id (and GNOME favorite) of an app's Linux shim. */
export function desktopFileId(appId: string): string {
  return `${LINUX_PREFIX}${appId}.desktop`;
}

function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The shim bundle's `Info.plist`. No `LSUIElement`: the shim's process is the
 * app's own Dock icon and window. `EquinAppId` / `EquinUrl` / `EquinNamespace`
 * are what the helper reads when launched from the bundle. The ATS exception
 * for `localhost` and its subdomains is what lets the bundle's WKWebView load
 * `http://*.localhost:9000` at all (`NSAllowsLocalNetworking` does not).
 */
export function renderShimInfoPlist(app: ShimApp): string {
  const s = (v: string) => `<string>${xmlEscape(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>${s(shimBundleId(app.id))}
  <key>CFBundleName</key>${s(app.name)}
  <key>CFBundleDisplayName</key>${s(app.name)}
  <key>CFBundleExecutable</key>${s(SHIM_EXECUTABLE)}
  <key>CFBundleIconFile</key>${s("app")}
  <key>CFBundlePackageType</key>${s("APPL")}
  <key>CFBundleShortVersionString</key>${s("0.1.0")}
  <key>CFBundleVersion</key>${s("1")}
  <key>CFBundleInfoDictionaryVersion</key>${s("6.0")}
  <key>LSMinimumSystemVersion</key>${s("11.0")}
  <key>NSHighResolutionCapable</key><true/>
  <key>EquinAppId</key>${s(app.id)}
  <key>EquinUrl</key>${s(app.url)}
  <key>EquinNamespace</key>${s(app.namespace)}
  <key>NSAppTransportSecurity</key><dict><key>NSExceptionDomains</key><dict><key>localhost</key><dict><key>NSIncludesSubdomains</key><true/><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict></dict></dict>
</dict>
</plist>
`;
}

/** `EquinAppId` read back from a shim's `Info.plist` (null: not an equin shim). */
export function readShimPlistAppId(plist: string): string | null {
  const m = /<key>EquinAppId<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
  return m ? m[1]! : null;
}

/** A desktop-entry value: newlines escaped, per the freedesktop spec. */
function desktopValue(v: string): string {
  return v
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

/** One `Exec=` argument, quoted when it needs to be (the spec's reserved characters). */
function execArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["`$\\])/g, "\\$1")}"`;
}

/**
 * The shim's desktop entry: runs the stable helper in window mode on the app's
 * URL. `StartupWMClass` is the window class the helper sets for that app, so
 * the shell groups its window under this launcher.
 */
export function renderDesktopFile(app: ShimApp, helper: string): string {
  const exec = [helper, "window", "--app", app.id, "--url", app.url]
    .map(execArg)
    .join(" ");
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=${desktopValue(app.name)}
Comment=${desktopValue(`${app.name} — an equin app`)}
Exec=${desktopValue(exec)}
Icon=${LINUX_PREFIX}${app.id}
StartupWMClass=${LINUX_PREFIX}${app.id}
Terminal=false
Categories=Utility;
X-Equin-AppId=${app.id}
X-Equin-Url=${desktopValue(app.url)}
X-Equin-Namespace=${app.namespace}
`;
}

/** `X-Equin-AppId` read back from a desktop entry (null: not an equin shim). */
export function readDesktopFileAppId(text: string): string | null {
  const m = /^X-Equin-AppId=(.+)$/m.exec(text);
  return m ? m[1]!.trim() : null;
}

/** A directory entry that may be an equin shim, by its name alone. */
export function isShimEntryName(
  platform: ShimPlatform,
  entry: string,
): boolean {
  return platform === "macos"
    ? entry.startsWith(MAC_BUNDLE_PREFIX) && entry.endsWith(".app")
    : entry.startsWith(LINUX_PREFIX) && entry.endsWith(".desktop");
}

/**
 * The `.iconset` members `iconutil` packs into `app.icns`, each with the pixel
 * size it is scaled to from the 1024 px render.
 */
export const ICONSET: ReadonlyArray<readonly [name: string, px: number]> = [
  ["icon_16x16", 16],
  ["icon_16x16@2x", 32],
  ["icon_32x32", 32],
  ["icon_32x32@2x", 64],
  ["icon_128x128", 128],
  ["icon_128x128@2x", 256],
  ["icon_256x256", 256],
  ["icon_256x256@2x", 512],
  ["icon_512x512", 512],
  ["icon_512x512@2x", 1024],
];

// --- Pinning ----------------------------------------------------------------

/** The `file://` URL the Dock names a bundle by (trailing slash, as it writes them). */
export function dockFileUrl(bundle: string): string {
  const href = pathToFileURL(bundle).href;
  return href.endsWith("/") ? href : `${href}/`;
}

/** The `persistent-apps` tile `defaults write … -array-add` appends for a bundle. */
export function dockTile(bundle: string): string {
  return `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${xmlEscape(dockFileUrl(bundle))}</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>`;
}

/** Reads the Dock's pinned apps (`defaults read com.apple.dock persistent-apps`). */
export const DOCK_READ_ARGV = [
  "defaults",
  "read",
  "com.apple.dock",
  "persistent-apps",
] as const;

/**
 * The commands that pin `bundle` to the Dock given what `DOCK_READ_ARGV`
 * printed — none when it is already there: append one `persistent-apps` tile,
 * then restart the Dock so it rereads its preferences (what `dockutil` does;
 * the Dock has no public API).
 */
export function dockPinPlan(
  persistentApps: string,
  bundle: string,
): string[][] {
  if (persistentApps.includes(dockFileUrl(bundle))) return [];
  return [
    [
      "defaults",
      "write",
      "com.apple.dock",
      "persistent-apps",
      "-array-add",
      dockTile(bundle),
    ],
    ["killall", "Dock"],
  ];
}

/** Reads GNOME's dash favorites. */
export const GNOME_FAVORITES_READ_ARGV = [
  "gsettings",
  "get",
  "org.gnome.shell",
  "favorite-apps",
] as const;

/**
 * A GVariant string array as `gsettings get` prints it — `['a.desktop',
 * 'b.desktop']`, or `@as []` when empty.
 */
export function parseGsettingsStrv(out: string): string[] {
  const text = out.trim().replace(/^@as\s+/, "");
  if (!text.startsWith("[") || !text.endsWith("]")) {
    throw new Error(`not a gsettings string array: ${JSON.stringify(out)}`);
  }
  const items: string[] = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  for (const m of text.slice(1, -1).matchAll(re)) {
    items.push((m[1] ?? m[2]!).replace(/\\(.)/g, "$1"));
  }
  return items;
}

/** A string array as `gsettings set` takes it. */
export function renderGsettingsStrv(items: readonly string[]): string {
  return `[${items.map((i) => `'${i.replace(/(['\\])/g, "\\$1")}'`).join(", ")}]`;
}

/**
 * The command that pins an app's desktop entry to the GNOME dash given what
 * `GNOME_FAVORITES_READ_ARGV` printed — none when it is already a favorite.
 */
export function gnomePinPlan(favorites: string, appId: string): string[][] {
  const current = parseGsettingsStrv(favorites);
  const id = desktopFileId(appId);
  if (current.includes(id)) return [];
  return [
    [
      "gsettings",
      "set",
      "org.gnome.shell",
      "favorite-apps",
      renderGsettingsStrv([...current, id]),
    ],
  ];
}
