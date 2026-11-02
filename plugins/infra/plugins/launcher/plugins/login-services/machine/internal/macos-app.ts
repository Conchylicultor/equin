import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type AppPath,
  appPathParent,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  codeSignature,
  rcodesign,
  registerApp,
  signBundle,
  type RcodesignTool,
} from "@plugins/infra/plugins/codesign/deps";
import type { Dep } from "@plugins/infra/plugins/deps/deps";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { waitForFlock } from "@plugins/packages/plugins/flock/core";
import {
  unbundledExecutable,
  type AppComponent,
  type ComponentBuild,
  type ServiceExecutable,
} from "../../core";
import { macosAppDir } from "../../data-dirs";
import {
  APP_BUNDLE_ID,
  ICON_NAME,
  readAppComponents,
  renderAppInfoPlist,
  type InstalledComponent,
} from "./macos-app-plist";

/**
 * The equin app on macOS: ONE bundle, `equin.app` (`dev.equin`), that every
 * login service runs from — the gateway (and through it every backend, which
 * macOS charges to it) and the menu-bar helper. So every permission prompt,
 * System Settings row and `tccutil reset <Service> dev.equin` names one
 * app, "equin", with its icon, rather than a bare executable called
 * `gateway` that cannot be reset on its own.
 *
 * Measured on macOS 26 (research/2026-10-25-global-gateway-app-bundle-v2.md):
 * an executable launchd runs straight from `Contents/MacOS` — the main one or
 * any other, each with its own LaunchAgent — is charged to the bundle; the
 * grant survives the bundle moving and being re-signed, and swapping a
 * re-signed bundle under a running executable keeps its grants (and its new
 * children's) — while the executable it runs still exists (see below). A
 * bundle under `/tmp` is disabled by LaunchServices.
 *
 * At a stable path, not in the per-build deps cache: the components rebuild
 * independently (a menu-bar rebuild must not restart the gateway), and macOS
 * wants one app. Installing a component copies its build in, re-signs the
 * whole bundle in a staging copy and swaps it in whole; the job's environment
 * names the build (`executableEnv`), so only that component's job changes.
 *
 * The bundle swapped out is kept, as `equin.app.old-*`, while a process still
 * runs an executable from it: macOS identifies a process by the file it runs,
 * and once that file is deleted tccd cannot (`proc_pidpath_audittoken() …
 * No such file or directory`), so every grant charged to it — the gateway's
 * Downloads, and so every backend's — is refused. That shows only once tccd's
 * cache expires, minutes after the swap. Every install sweeps the kept
 * bundles nothing runs from any more ({@link sweepOldBundles}); main's boot
 * installs on every boot, so a gateway restart frees its old bundle.
 *
 * Linux has no bundle: a service runs its build where it was built.
 */

/** What installing touches outside the bundle's own files — injected by tests. */
export interface MacosAppHost {
  readonly platform: NodeJS.Platform;
  /** `equin.app`'s path. */
  readonly bundle: AppPath;
  /** Run `fn` holding the machine-wide lock on the bundle. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Sign the staged bundle in place, as {@link APP_BUNDLE_ID}. */
  sign(staging: AppPath): Promise<void>;
  /** Whether the installed bundle is signed by this machine's identity. */
  isSigned(bundle: AppPath): Promise<boolean>;
  /** Register the bundle with LaunchServices (`tccutil` and Settings resolve it through it). */
  register(bundle: AppPath): Promise<void>;
  /** The real path of every executable a running process of this user was started from. */
  executablesInUse(): Promise<string[]>;
}

/**
 * The real machine. `tool` is where `rcodesign` comes from (see
 * {@link RcodesignTool}); null only off macOS, where nothing is signed.
 */
export function machineMacosAppHost(
  tool: RcodesignTool | null,
  log: (line: string) => void,
): MacosAppHost {
  const bundle = macosAppDir.file("equin.app");
  return {
    platform: process.platform,
    bundle,
    async withLock(fn) {
      macosAppDir.ensure();
      const held = await waitForFlock(macosAppDir.file("equin.app.lock"));
      try {
        return await fn();
      } finally {
        await held.release();
      }
    },
    async sign(staging) {
      if (tool === null) {
        throw new Error(
          `signing ${staging} needs rcodesign, and this caller passed no way to get it`,
        );
      }
      await signBundle(staging, { identifier: APP_BUNDLE_ID, tool, log });
    },
    async isSigned(path) {
      return (await codeSignature(path, APP_BUNDLE_ID)) === "signed";
    },
    register: (path) => registerApp(path),
    executablesInUse: runningExecutables,
  };
}

/** No `lsof` over every process takes longer than this (measured: under 1 s). */
const LSOF_TIMEOUT_MS = 30_000;

/** Every running process's executable (lsof's `txt` descriptors), by real path. */
async function runningExecutables(): Promise<string[]> {
  const argv = ["lsof", "-d", "txt", "-F", "n"];
  const result = await spawnCaptured(argv, {
    cwd: tmpdir(),
    env: { ...process.env },
    timeoutMs: LSOF_TIMEOUT_MS,
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(
      `\`${argv.join(" ")}\` ${result.timedOut ? `did not finish within ${LSOF_TIMEOUT_MS / 1000}s` : `failed (exit ${result.exitCode}): ${result.stderr.trim() || "(no output)"}`} — cannot tell which old equin.app bundles are still running`,
    );
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

/** Where `component`'s executable lives inside the bundle. */
export function appExecutablePath(bundle: AppPath, name: string): AppPath {
  return joinAppPath(bundle, "Contents", "MacOS", name);
}

/** The bundle that holds the executable at `path`, or null when it is not inside `bundle`. */
export function bundleOfExecutable(
  bundle: AppPath,
  path: string,
): AppPath | null {
  return dirname(path) === join(bundle, "Contents", "MacOS") ? bundle : null;
}

/**
 * Where `component`'s build WOULD run once installed — what a job names,
 * computed without installing anything (the gateway's staleness notice, the
 * drift row). macOS: inside the bundle; elsewhere: the build itself.
 */
export function plannedServiceExecutable(
  host: Pick<MacosAppHost, "platform" | "bundle">,
  component: AppComponent,
  build: ComponentBuild,
): ServiceExecutable {
  if (host.platform !== "darwin") return unbundledExecutable(build);
  return {
    path: appExecutablePath(host.bundle, component.name),
    identity: build.identity,
    bundled: true,
  };
}

/** The components the installed bundle records, or null when there is none (or it is not ours). */
export function installedAppComponents(
  bundle: AppPath,
): InstalledComponent[] | null {
  const plist = joinAppPath(bundle, "Contents", "Info.plist");
  if (!existsSync(plist)) return null;
  return readAppComponents(readFileSync(plist, "utf8"));
}

/**
 * Put `build` of `component` into the bundle — a no-op when the bundle already
 * holds that build, signed by this machine's identity — and return where its
 * job runs it. Off macOS: the build, untouched.
 *
 * The bundle is copied to a staging directory beside it, the executable (and
 * the icon it brings) replaced, `Info.plist` rewritten, the staging copy signed
 * and verified, then swapped in whole: a running component's executable is
 * never rewritten in place, and a failure leaves the installed bundle as it
 * was. Under a machine-wide lock: `./equin start` and main's boot may install
 * at once.
 */
export async function installServiceExecutable(
  host: MacosAppHost,
  component: AppComponent,
  build: ComponentBuild,
  log: (line: string) => void,
): Promise<ServiceExecutable> {
  const planned = plannedServiceExecutable(host, component, build);
  if (!planned.bundled) return planned;
  return host.withLock(async () => {
    const installed = installedAppComponents(host.bundle);
    const entry: InstalledComponent = {
      name: component.name,
      identity: build.identity,
      main: component.main === true,
      icon: build.icon !== undefined,
    };
    const current = installed?.find((c) => c.name === component.name);
    if (
      current !== undefined &&
      sameComponent(current, entry) &&
      (await host.isSigned(host.bundle))
    ) {
      await sweepOldBundles(host, log);
      return planned;
    }

    const staging = joinAppPath(
      appPathParent(host.bundle),
      `${basename(host.bundle)}.staging-${process.pid}-${randomBytes(4).toString("hex")}`,
    );
    const old = joinAppPath(
      appPathParent(host.bundle),
      `${basename(host.bundle)}.old-${process.pid}-${randomBytes(4).toString("hex")}`,
    );
    try {
      // A bundle that is not ours (no record) is rebuilt, never merged into.
      if (installed !== null) cpSync(host.bundle, staging, { recursive: true });
      const contents = joinAppPath(staging, "Contents");
      mkdirSync(joinAppPath(contents, "MacOS"), { recursive: true });
      mkdirSync(joinAppPath(contents, "Resources"), { recursive: true });
      const executable = appExecutablePath(staging, component.name);
      rmSync(executable, { force: true });
      // A build from the deps cache.
      copyFileSync(build.file, executable);
      chmodSync(executable, 0o755);
      if (build.icon !== undefined) {
        copyFileSync(
          build.icon,
          joinAppPath(contents, "Resources", `${ICON_NAME}.icns`),
        );
      }
      const components = [
        ...(installed ?? []).filter((c) => c.name !== component.name),
        entry,
      ];
      writeFileSync(
        joinAppPath(contents, "Info.plist"),
        renderAppInfoPlist(components),
      );
      await host.sign(staging);
      if (existsSync(host.bundle)) renameSync(host.bundle, old);
      try {
        renameSync(staging, host.bundle);
      } catch (err) {
        // Put the previous bundle back: the services' jobs name its path.
        if (existsSync(old)) renameSync(old, host.bundle);
        throw err;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    await host.register(host.bundle);
    log(`Installed ${component.name} (${build.identity}) into ${host.bundle}`);
    await sweepOldBundles(host, log);
    return planned;
  });
}

/**
 * Delete every swapped-out bundle (`equin.app.old-*`, beside the bundle) no
 * running process was started from; keep the rest until a later install.
 * Under the bundle lock, so no swap is renaming one meanwhile.
 */
async function sweepOldBundles(
  host: MacosAppHost,
  log: (line: string) => void,
): Promise<void> {
  const parent = asAppPath(dirname(host.bundle));
  const prefix = `${basename(host.bundle)}.old-`;
  const old = readdirSync(parent)
    .filter((name) => name.startsWith(prefix))
    .map((name) => joinAppPath(parent, name));
  if (old.length === 0) return;
  const running = await host.executablesInUse();
  for (const dir of old) {
    const real = `${realpathSync(dir)}/`;
    const users = running.filter((path) => path.startsWith(real));
    if (users.length > 0) {
      log(`Kept ${dir}: still running ${users.join(", ")}`);
    } else {
      rmSync(dir, { recursive: true, force: true });
      log(`Removed ${dir}: nothing runs from it any more`);
    }
  }
}

function sameComponent(a: InstalledComponent, b: InstalledComponent): boolean {
  return a.identity === b.identity && a.main === b.main && a.icon === b.icon;
}

/**
 * What installing into the bundle needs installed first, for a caller with no
 * `ExecContext` (main's boot, which waits for them through `deps`): `rcodesign`
 * on macOS, nothing elsewhere.
 */
export function macosAppToolDeps(platform: NodeJS.Platform): Dep[] {
  return platform === "darwin" ? [rcodesign] : [];
}
