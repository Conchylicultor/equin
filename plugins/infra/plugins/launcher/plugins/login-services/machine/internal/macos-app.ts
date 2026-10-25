import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  codeSignature,
  rcodesign,
  registerApp,
  signBundle,
  type RcodesignTool,
} from "@plugins/infra/plugins/codesign/deps";
import type { Dep } from "@plugins/infra/plugins/deps/deps";
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
 * children's). A bundle under `/tmp` is disabled by LaunchServices.
 *
 * At a stable path, not in the per-build deps cache: the components rebuild
 * independently (a menu-bar rebuild must not restart the gateway), and macOS
 * wants one app. Installing a component copies its build in, re-signs the
 * whole bundle in a staging copy and swaps it in whole; the job's environment
 * names the build (`executableEnv`), so only that component's job changes.
 *
 * Linux has no bundle: a service runs its build where it was built.
 */

/** What installing touches outside the bundle's own files — injected by tests. */
export interface MacosAppHost {
  readonly platform: NodeJS.Platform;
  /** `equin.app`'s path. */
  readonly bundle: string;
  /** Run `fn` holding the machine-wide lock on the bundle. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Sign the staged bundle in place, as {@link APP_BUNDLE_ID}. */
  sign(staging: string): Promise<void>;
  /** Whether the installed bundle is signed by this machine's identity. */
  isSigned(bundle: string): Promise<boolean>;
  /** Register the bundle with LaunchServices (`tccutil` and Settings resolve it through it). */
  register(bundle: string): Promise<void>;
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
  };
}

/** Where `component`'s executable lives inside the bundle. */
export function appExecutablePath(bundle: string, name: string): string {
  return join(bundle, "Contents", "MacOS", name);
}

/** The bundle that holds the executable at `path`, or null when it is not inside `bundle`. */
export function bundleOfExecutable(
  bundle: string,
  path: string,
): string | null {
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
  bundle: string,
): InstalledComponent[] | null {
  const plist = join(bundle, "Contents", "Info.plist");
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
      return planned;
    }

    const staging = `${host.bundle}.staging-${process.pid}-${randomBytes(4).toString("hex")}`;
    const old = `${host.bundle}.old-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      // A bundle that is not ours (no record) is rebuilt, never merged into.
      if (installed !== null) cpSync(host.bundle, staging, { recursive: true });
      const contents = join(staging, "Contents");
      mkdirSync(join(contents, "MacOS"), { recursive: true });
      mkdirSync(join(contents, "Resources"), { recursive: true });
      const executable = appExecutablePath(staging, component.name);
      rmSync(executable, { force: true });
      copyFileSync(build.file, executable);
      chmodSync(executable, 0o755);
      if (build.icon !== undefined) {
        copyFileSync(
          build.icon,
          join(contents, "Resources", `${ICON_NAME}.icns`),
        );
      }
      const components = [
        ...(installed ?? []).filter((c) => c.name !== component.name),
        entry,
      ];
      writeFileSync(
        join(contents, "Info.plist"),
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
      rmSync(old, { recursive: true, force: true });
    }
    await host.register(host.bundle);
    log(`Installed ${component.name} (${build.identity}) into ${host.bundle}`);
    return planned;
  });
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
