import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DOCK_READ_ARGV,
  GNOME_FAVORITES_READ_ARGV,
  ICONSET,
  dockPinnedAppIds,
  dockPinPlan,
  gnomePinnedAppIds,
  gnomePinPlan,
  isShimEntryName,
  linuxShimPaths,
  macShimPaths,
  readDesktopFile,
  readShimPlist,
  renderDesktopFile,
  renderShimInfoPlist,
  shimDir,
  shimHash,
  SHIM_EXECUTABLE,
  type ShimApp,
  type ShimPlatform,
  type ShimRecord,
  type ShimRoots,
} from "./shim-files";

/**
 * Everything writing a shim touches outside its own files, injected so a test
 * drives it against a `/tmp` root with a fake command runner — never the real
 * `~/Applications`, Dock or `gsettings`.
 */
export interface ShimHost {
  platform: ShimPlatform;
  roots: ShimRoots;
  /** Run one command; resolves its stdout, rejects on a non-zero exit. */
  run(argv: readonly string[]): Promise<string>;
  /** The app's icon as a PNG at `size` px (the app-manifest renderer). */
  iconPng(appId: string, size: number): Uint8Array;
}

/** One shim on disk: what it says about itself, and where it is. */
export interface InstalledShim extends ShimRecord {
  /** macOS: the bundle; Linux: the desktop entry. */
  path: string;
}

/** Every equin shim on disk now — read from the shim files themselves. */
export function readInstalledShims(host: ShimHost): InstalledShim[] {
  const dir = shimDir(host.platform, host.roots);
  if (!existsSync(dir)) return [];
  const shims: InstalledShim[] = [];
  for (const entry of readdirSync(dir)) {
    if (!isShimEntryName(host.platform, entry)) continue;
    const path = join(dir, entry);
    const record =
      host.platform === "macos"
        ? readIfExists(join(path, "Contents", "Info.plist"), readShimPlist)
        : readIfExists(path, readDesktopFile);
    if (record !== null) shims.push({ ...record, path });
  }
  return shims.sort((a, b) => a.path.localeCompare(b.path));
}

/** The app ids whose shims are on disk now. */
export function readInstalledAppIds(host: ShimHost): string[] {
  return [...new Set(readInstalledShims(host).map((s) => s.appId))].sort();
}

/** Where an app's shim is written: macOS its bundle, Linux its desktop entry. */
function shimPath(host: ShimHost, app: ShimApp): string {
  return host.platform === "macos"
    ? macShimPaths(host.roots, app).bundle
    : linuxShimPaths(host.roots, app.id).desktopFile;
}

function readIfExists(
  path: string,
  read: (text: string) => ShimRecord | null,
): ShimRecord | null {
  // A bundle named like a shim but without our plist is not ours — skipped.
  if (!existsSync(path)) return null;
  return read(readFileSync(path, "utf-8"));
}

/**
 * Write (or rewrite) an app's shim, running `helper` — the stable copy.
 *
 * - macOS: the bundle is assembled beside its final path and swapped in whole
 *   — `Contents/MacOS/equin-desktop` an APFS clone of the helper (`cp -c`: the
 *   process must live in the shim's bundle to get its own Dock icon),
 *   `Info.plist`, `Resources/app.icns` (every iconset size rendered in-process,
 *   `iconutil` packs them), then an ad-hoc signature (`codesign -s -`) — so a
 *   running app's executable is never overwritten in place.
 * - Linux: the 512 px icon under the hicolor theme, then the desktop entry
 *   (written last, so the launcher never names a missing icon).
 */
export async function writeShim(
  host: ShimHost,
  app: ShimApp,
  helper: string,
): Promise<void> {
  if (host.platform === "macos") await writeMacShim(host, app, helper);
  else writeLinuxShim(host, app, helper);
}

async function writeMacShim(
  host: ShimHost,
  app: ShimApp,
  helper: string,
): Promise<void> {
  const final = macShimPaths(host.roots, app);
  mkdirSync(host.roots.macApplications, { recursive: true });
  const staging = `${final.bundle}.staging`;
  rmSync(staging, { recursive: true, force: true });
  const paths = { ...final, ...stagedPaths(staging) };
  mkdirSync(dirname(paths.executable), { recursive: true });
  mkdirSync(dirname(paths.icns), { recursive: true });
  try {
    await host.run(["cp", "-c", helper, paths.executable]);
    writeFileSync(paths.infoPlist, renderShimInfoPlist(app));
    await writeIcns(host, app.id, paths.icns);
    await host.run(["codesign", "--force", "--sign", "-", staging]);
    rmSync(final.bundle, { recursive: true, force: true });
    renameSync(staging, final.bundle);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

function stagedPaths(bundle: string) {
  const contents = join(bundle, "Contents");
  return {
    executable: join(contents, "MacOS", SHIM_EXECUTABLE),
    infoPlist: join(contents, "Info.plist"),
    icns: join(contents, "Resources", "app.icns"),
  };
}

async function writeIcns(
  host: ShimHost,
  appId: string,
  icns: string,
): Promise<void> {
  // The iconset is scratch, outside the bundle.
  const scratch = mkdtempSync(join(tmpdir(), "equin-shim-icon-"));
  try {
    const iconset = join(scratch, "app.iconset");
    mkdirSync(iconset);
    // Rendered here, each at its own size: ten `sips` runs took ~2 s.
    for (const [name, px] of ICONSET) {
      writeFileSync(join(iconset, `${name}.png`), host.iconPng(appId, px));
    }
    await host.run(["iconutil", "-c", "icns", iconset, "-o", icns]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function writeLinuxShim(host: ShimHost, app: ShimApp, helper: string): void {
  const paths = linuxShimPaths(host.roots, app.id);
  mkdirSync(dirname(paths.icon), { recursive: true });
  writeAtomic(paths.icon, host.iconPng(app.id, 512));
  mkdirSync(dirname(paths.desktopFile), { recursive: true });
  writeAtomic(paths.desktopFile, renderDesktopFile(app, helper));
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * Pin an installed shim where the host keeps launchers: the Dock (macOS:
 * one `persistent-apps` tile, then `killall Dock`), the GNOME dash (the
 * `favorite-apps` key). Already pinned → nothing runs. Call only when the
 * host's `capabilities.pin` says so.
 */
export async function pinShim(host: ShimHost, app: ShimApp): Promise<void> {
  const plan =
    host.platform === "macos"
      ? dockPinPlan(
          await host.run(DOCK_READ_ARGV),
          macShimPaths(host.roots, app).bundle,
        )
      : gnomePinPlan(await host.run(GNOME_FAVORITES_READ_ARGV), app.id);
  for (const argv of plan) await host.run(argv);
}

/** The stable helper copy inside the menu-bar state dir. */
export interface StableHelper {
  /** The binary every shim runs (Linux) / clones (macOS). */
  binary: string;
  /** Did this sync replace it (a new helper identity)? */
  changed: boolean;
}

/**
 * Bring the stable helper copy in `stateDir` to `identity`: when the recorded
 * identity differs (or nothing is there), copy `source` in beside it and
 * rename it over (a running shim on Linux keeps its old inode), then record
 * the identity. The shims never name the deps cache, whose identity
 * directories the sweep deletes.
 */
export function syncStableHelper(
  stateDir: string,
  source: string,
  identity: string,
): StableHelper {
  const binary = join(stateDir, SHIM_EXECUTABLE);
  const identityFile = join(stateDir, "helper-identity");
  const recorded = existsSync(identityFile)
    ? readFileSync(identityFile, "utf-8").trim()
    : null;
  if (recorded === identity && existsSync(binary)) {
    return { binary, changed: false };
  }
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${binary}.tmp`;
  copyFileSync(source, tmp);
  chmodSync(tmp, 0o755);
  renameSync(tmp, binary);
  writeFileSync(identityFile, `${identity}\n`);
  return { binary, changed: true };
}

/** Is there a stable helper copy at all (has anything ever been installed)? */
export function hasStableHelper(stateDir: string): boolean {
  return existsSync(join(stateDir, SHIM_EXECUTABLE));
}

/** Remove one shim from disk (Linux: its icon too). */
function removeShim(host: ShimHost, shim: InstalledShim): void {
  rmSync(shim.path, { recursive: true, force: true });
  if (host.platform === "linux") {
    rmSync(linuxShimPaths(host.roots, shim.appId).icon, { force: true });
  }
}

/** What one {@link syncShims} run changed, by app id. */
export interface ShimSync {
  written: string[];
  removed: string[];
}

/**
 * Bring the shims on disk to exactly `apps`, each running `helper`:
 *
 * - an app with no shim, or whose shim is stale (its recorded fingerprint is
 *   not the app's `shimHash`, or `rewriteAll` — the helper binary changed),
 *   is (re)written;
 * - a shim under another path than its app's (an app renamed: the macOS
 *   bundle is named after the app) is removed once the new one is written;
 * - a shim whose app is not in `apps` (an app that no longer exists) is
 *   removed.
 *
 * Only equin's own shims are touched (`readInstalledShims` reads the shim's
 * own `EquinAppId`). A current shim is left alone, so a sync with nothing to
 * do runs no command.
 */
export async function syncShims(
  host: ShimHost,
  helper: string,
  apps: readonly ShimApp[],
  opts: { rewriteAll: boolean },
): Promise<ShimSync> {
  const onDisk = readInstalledShims(host);
  const wanted = new Map(apps.map((a) => [a.id, a]));
  const result: ShimSync = { written: [], removed: [] };
  for (const app of apps) {
    const path = shimPath(host, app);
    const current = onDisk.find((s) => s.path === path && s.appId === app.id);
    if (opts.rewriteAll || current?.hash !== shimHash(app)) {
      await writeShim(host, app, helper);
      result.written.push(app.id);
    }
  }
  for (const shim of onDisk) {
    const app = wanted.get(shim.appId);
    if (app !== undefined && shimPath(host, app) === shim.path) continue;
    removeShim(host, shim);
    result.removed.push(shim.appId);
  }
  return result;
}

/**
 * Which installed shims the Dock (macOS) / GNOME dash (Linux) keeps. Call
 * only when the host's `capabilities.pin` says so.
 */
export async function readPinnedAppIds(host: ShimHost): Promise<string[]> {
  const shims = readInstalledShims(host);
  if (host.platform === "macos") {
    return dockPinnedAppIds(
      await host.run(DOCK_READ_ARGV),
      shims.map((s) => ({ appId: s.appId, bundle: s.path })),
    );
  }
  return gnomePinnedAppIds(
    await host.run(GNOME_FAVORITES_READ_ARGV),
    shims.map((s) => s.appId),
  );
}
