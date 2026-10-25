import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";

/**
 * The equin app's bundle id: what macOS files every permission of every login
 * service under (Files & Folders, Notifications, Login Items), and what
 * `tccutil reset <Service> dev.equin` resets. The per-app shims
 * (`dev.equin.app.<id>`) sit under it. Not `dev.equin.app`: an id ending in
 * `.app` names folders (`~/Library/Application Support/<id>`) that Finder takes
 * for app bundles — Tauri warns against it, and this is the menu-bar helper's
 * Tauri identifier too (`rust/tauri.conf.json`), which its notifications use.
 */
export const APP_BUNDLE_ID = "dev.equin";

/** The bundle's icon, `Contents/Resources/<ICON_NAME>.icns`. */
export const ICON_NAME = "equin";

/** One installed component, as the bundle's `Info.plist` records it. */
export interface InstalledComponent {
  name: string;
  /** Its build: `componentIdentity` of its dependency. */
  identity: string;
  main: boolean;
  /** Whether it brought the bundle's icon. */
  icon: boolean;
}

/**
 * The executable the bundle runs as its main one: the component declared
 * `main`, else (it is not installed yet) the first by name — a bundle needs
 * one, and which one stands in changes nothing macOS keys a permission to.
 */
export function mainComponent(
  components: readonly InstalledComponent[],
): InstalledComponent {
  const sorted = [...components].sort((a, b) => a.name.localeCompare(b.name));
  const main = sorted.find((c) => c.main) ?? sorted[0];
  if (main === undefined) throw new Error("an app bundle needs a component");
  return main;
}

/**
 * `equin.app`'s `Info.plist`. Fixed but for the components:
 *
 * - `LSUIElement` — no Dock icon or app-switcher entry: the gateway has no
 *   window, and the menu-bar helper's status item is its only presence.
 * - The ATS exception for `localhost` and its subdomains — inside a bundle,
 *   App Transport Security blocks the helper's webview loading
 *   `http://<ns>.localhost:9000` otherwise (`NSAllowsLocalNetworking` does not
 *   cover `*.localhost`).
 * - `EquinComponents` — which build of which component is inside (JSON), read
 *   back by {@link readAppComponents}: "is this component current?" is a file
 *   read, not a hash of the executables.
 */
export function renderAppInfoPlist(
  components: readonly InstalledComponent[],
): string {
  const s = (v: string) => `<string>${xmlEscape(v)}</string>`;
  const sorted = [...components].sort((a, b) => a.name.localeCompare(b.name));
  const icon = sorted.some((c) => c.icon)
    ? `  <key>CFBundleIconFile</key>${s(ICON_NAME)}\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>${s(APP_BUNDLE_ID)}
  <key>CFBundleName</key>${s(PRODUCT_NAME)}
  <key>CFBundleDisplayName</key>${s(PRODUCT_NAME)}
  <key>CFBundleExecutable</key>${s(mainComponent(sorted).name)}
${icon}  <key>CFBundlePackageType</key>${s("APPL")}
  <key>CFBundleShortVersionString</key>${s("0.1.0")}
  <key>CFBundleVersion</key>${s("1")}
  <key>CFBundleInfoDictionaryVersion</key>${s("6.0")}
  <key>LSMinimumSystemVersion</key>${s("11.0")}
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSExceptionDomains</key><dict><key>localhost</key><dict><key>NSIncludesSubdomains</key><true/><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict></dict></dict>
  <key>EquinComponents</key>${s(JSON.stringify(sorted))}
</dict>
</plist>
`;
}

/**
 * The components a bundle's `Info.plist` records, or null when it is not one
 * {@link renderAppInfoPlist} wrote (another bundle id, no record) — never a
 * guess: an unknown bundle is rebuilt, not merged into.
 */
export function readAppComponents(plist: string): InstalledComponent[] | null {
  if (plistString(plist, "CFBundleIdentifier") !== APP_BUNDLE_ID) return null;
  const raw = plistString(plist, "EquinComponents");
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(xmlUnescape(raw));
  if (!Array.isArray(parsed) || !parsed.every(isInstalledComponent)) {
    throw new Error(
      `equin.app's Info.plist records malformed EquinComponents: ${raw}`,
    );
  }
  return parsed;
}

function isInstalledComponent(v: unknown): v is InstalledComponent {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.name === "string" &&
    typeof c.identity === "string" &&
    typeof c.main === "boolean" &&
    typeof c.icon === "boolean"
  );
}

function plistString(plist: string, key: string): string | null {
  return (
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(
      plist,
    )?.[1] ?? null
  );
}

function xmlEscape(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function xmlUnescape(v: string): string {
  return v
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
