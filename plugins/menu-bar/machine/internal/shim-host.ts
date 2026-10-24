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
  dockPinPlan,
  gnomePinPlan,
  isShimEntryName,
  linuxShimPaths,
  macShimPaths,
  readDesktopFileAppId,
  readShimPlistAppId,
  renderDesktopFile,
  renderShimInfoPlist,
  shimDir,
  SHIM_EXECUTABLE,
  type ShimApp,
  type ShimPlatform,
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
  iconPng(appId: string, size: 512 | 1024): Uint8Array;
}

/** The app ids whose shims are on disk now — read from the shim files themselves. */
export function readInstalledAppIds(host: ShimHost): string[] {
  const dir = shimDir(host.platform, host.roots);
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!isShimEntryName(host.platform, entry)) continue;
    const id =
      host.platform === "macos"
        ? readIfExists(
            join(dir, entry, "Contents", "Info.plist"),
            readShimPlistAppId,
          )
        : readIfExists(join(dir, entry), readDesktopFileAppId);
    if (id !== null) ids.push(id);
  }
  return ids.sort();
}

function readIfExists(
  path: string,
  read: (text: string) => string | null,
): string | null {
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
 *   `Info.plist`, `Resources/app.icns` (`sips` scales the 1024 px render,
 *   `iconutil` packs it), then an ad-hoc signature (`codesign -s -`) — so a
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
    const source = join(scratch, "source.png");
    writeFileSync(source, host.iconPng(appId, 1024));
    const iconset = join(scratch, "app.iconset");
    mkdirSync(iconset);
    for (const [name, px] of ICONSET) {
      await host.run([
        "sips",
        "-z",
        String(px),
        String(px),
        source,
        "--out",
        join(iconset, `${name}.png`),
      ]);
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

/**
 * Re-sync every installed shim to the stable helper after its identity
 * changed: each shim whose app still exists is rewritten (macOS: a fresh
 * clone of the new binary, re-signed). A shim for an app that no longer
 * exists is left alone — removing an install is the user's call. Returns the
 * app ids rewritten.
 */
export async function reconcileShims(
  host: ShimHost,
  helper: string,
  resolve: (appId: string) => ShimApp | undefined,
): Promise<string[]> {
  const rewritten: string[] = [];
  for (const id of readInstalledAppIds(host)) {
    const app = resolve(id);
    if (app === undefined) continue;
    await writeShim(host, app, helper);
    rewritten.push(id);
  }
  return rewritten;
}
