import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
/**
 * One program of the equin app — on macOS an executable inside the ONE
 * `equin.app` bundle every login service runs from (`machine/internal/macos-app.ts`),
 * so each service's permission prompts, Settings rows and `tccutil` resets
 * name the app, "equin", not the program file; on Linux the build as it is.
 */
export interface AppComponent {
  /** The executable's file name in `Contents/MacOS` (and so its process name): `gateway`, `equin-desktop`. */
  readonly name: string;
  /**
   * The bundle's main executable (`CFBundleExecutable`): what `Bundle.main`
   * and notifications see, and what opening the bundle runs. At most one
   * component is main; while it is not installed yet, another one stands in.
   */
  readonly main?: boolean;
}

/** One build of an {@link AppComponent}: what installing it copies, and which build that is. */
export interface ComponentBuild {
  /** The built executable (in the deps cache). */
  readonly file: string;
  /** An `.icns` the bundle wears, when this component brings the app's icon. */
  readonly icon?: string;
  /** Which build: {@link componentIdentity} of its dependency. */
  readonly identity: string;
}

/** What a service's job runs: the executable's path, and which build is there. */
export interface ServiceExecutable {
  readonly path: string;
  readonly identity: string;
  /**
   * Whether `path` is inside the app bundle — a stable path, unlike a deps
   * cache path, which names its build. Then the job carries the build in its
   * environment ({@link executableEnv}), so a rebuilt component still changes
   * its job (and so reloads it), and only its own.
   */
  readonly bundled: boolean;
}

/** A component build's identity: the dependency and its build identity. */
export function componentIdentity(depId: string, identity: string): string {
  return `${depId}@${identity}`;
}

/** An executable run where it was built (Linux, a release, a host without the bundle). */
export function unbundledExecutable(build: ComponentBuild): ServiceExecutable {
  return { path: build.file, identity: build.identity, bundled: false };
}

/**
 * The environment entries a job running `executable` adds: the build of a
 * bundled one (see {@link ServiceExecutable.bundled}), nothing otherwise — an
 * unbundled path already names its build.
 */
export function executableEnv(
  executable: ServiceExecutable,
): Record<string, string> {
  // A bundled service's job names its component build in APP_COMPONENT.
  return executable.bundled
    ? envEntries({ APP_COMPONENT: executable.identity })
    : {};
}
