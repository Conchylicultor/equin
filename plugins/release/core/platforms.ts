/**
 * The closed set of platforms a release can be built for, and the derivations
 * every consumer needs from a tag.
 *
 * A closed list both runtimes need lives here as plain data rather than behind a
 * slot — the same call `RELEASE_TARGETS` makes next door. Three very different
 * consumers read it, which is exactly why the derivations live with the list
 * instead of at each call site:
 *
 * - the release CLI resolves `--platform`, then needs the Bun compile target and
 *   the Node platform/arch its sealed dependencies are built for;
 * - the Deploy health probe parses `uname -sm` into a tag it can store;
 * - `ship` compares a bundle's tag against a server's observed tag.
 *
 * Getting the Bun target prefix or the arch spelling wrong is a silent
 * mis-build (a Mach-O binary wrapping a Linux payload, or vice versa), so both
 * mappings are single-sourced here.
 */

import { z } from "zod";

export const PLATFORM_TAGS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
] as const;

export type PlatformTag = (typeof PLATFORM_TAGS)[number];

/**
 * The wire form of {@link PLATFORM_TAGS} — for an endpoint body/query that names
 * a platform. Built FROM the closed list rather than restating it, so a new tag
 * is one line above and validation follows for free.
 */
export const PlatformTagSchema = z.enum(PLATFORM_TAGS);

export function isPlatformTag(value: string): value is PlatformTag {
  return (PLATFORM_TAGS as readonly string[]).includes(value);
}

/**
 * Resolving an unknown string to a tag either succeeds or explains itself.
 *
 * Deliberately NOT `PlatformTag | null`: a null tag is a legitimate value
 * elsewhere in this feature (a server whose platform has never been probed), so
 * returning null here would make "we could not read this" indistinguishable from
 * "we have never looked". See the absorbable-failure rule.
 */
export type PlatformTagResult =
  { ok: true; tag: PlatformTag } | { ok: false; reason: string };

/**
 * Node's `process.platform`/`process.arch` pair → tag. The caller reads
 * `process` itself: this module is loaded in the browser (Deploy's health
 * rows, the release artifact pane), where there is no process.
 */
export function platformTagFor(
  platform: string,
  arch: string,
): PlatformTagResult {
  const os = platform === "darwin" || platform === "linux" ? platform : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!os || !cpu) {
    return { ok: false, reason: `unsupported platform ${platform}/${arch}` };
  }
  return { ok: true, tag: `${os}-${cpu}` as PlatformTag };
}

/**
 * `uname -sm` output → tag. The Deploy health probe runs `uname -sm` (a command
 * that cannot fail on a reachable POSIX host, preserving the probe's property
 * that any non-zero exit is unambiguously an SSH-layer failure) and stores the
 * result of this parse.
 */
export function platformTagFromUname(unameSm: string): PlatformTagResult {
  const parts = unameSm.trim().split(/\s+/);
  const [sysname, machine] = parts;
  if (parts.length !== 2 || !sysname || !machine) {
    return {
      ok: false,
      reason: `could not parse \`uname -sm\` output ${JSON.stringify(unameSm)}`,
    };
  }
  const os =
    sysname === "Darwin" ? "darwin" : sysname === "Linux" ? "linux" : null;
  // uname reports the machine name, which is not Node's `arch` spelling.
  const cpu =
    machine === "arm64" || machine === "aarch64"
      ? "arm64"
      : machine === "x86_64" || machine === "amd64"
        ? "x64"
        : null;
  if (!os || !cpu) {
    return { ok: false, reason: `unsupported host ${sysname} ${machine}` };
  }
  return { ok: true, tag: `${os}-${cpu}` as PlatformTag };
}

/**
 * The Bun standalone-compile target for a tag.
 *
 * The `bun-` prefix is MANDATORY — `Bun.Build.CompileTarget` is
 * `` `bun-${Platform}-${Architecture}` ``, and the JSDoc example in `bun.d.ts`
 * showing a bare `linux-x64` is wrong and does not typecheck. `bun-linux-x64`
 * resolves to the glibc/AVX2 build, consistent with the `linux-x64` (glibc)
 * embedded-Postgres and `@parcel/watcher-linux-x64-glibc` choices; the
 * `-baseline` variants would be the escape hatch if pre-AVX2 hosts ever matter.
 */
export function bunCompileTarget(tag: PlatformTag): string {
  return `bun-${tag}`;
}

/**
 * A tag as Node spells a platform (`process.platform` / `process.arch`) — the
 * target `infra/deps` seals a bundle's dependencies for (the gateway binary),
 * whose kinds turn it into their own toolchain's terms (Go's GOOS/GOARCH).
 */
export function nodeTargetFor(tag: PlatformTag): {
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
} {
  const [os, cpu] = tag.split("-");
  return {
    platform: os === "darwin" ? "darwin" : "linux",
    arch: cpu === "arm64" ? "arm64" : "x64",
  };
}

/** True when a tag targets Linux — for target-conditional packaging choices. */
export function isLinuxTag(tag: PlatformTag): boolean {
  return tag.startsWith("linux-");
}
