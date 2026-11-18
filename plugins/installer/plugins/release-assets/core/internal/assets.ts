import { z } from "zod";
import { INSTALL_PROTOCOL_VERSION } from "@plugins/installer/core";

/**
 * What a release tag publishes on its GitHub Release, for the curl install.
 *
 * The workflow that publishes it (`RELEASE_WORKFLOW`) is YAML and bash, and
 * install.sh's stage 0 (bash) and the window's self-bootstrap (Rust) read it:
 * none of them can import this file. It is the written-down contract they
 * all follow, and the `release-assets:*` checks hold the workflow to the
 * parts that would drift silently (the tag grammar, the asset names).
 */

/** The workflow that builds and publishes a release's installer assets. */
export const RELEASE_WORKFLOW = ".github/workflows/installer-release.yml";

/**
 * What every installer binary's name starts with: the rest is its platform
 * key. install.sh spells it as `equin-installer-$key` (it reads no
 * manifest field for it since v2), which `release-assets:asset-names` holds.
 */
export const INSTALLER_BINARY_PREFIX = "equin-installer-";

/**
 * The installer window's binary per platform, keyed as stage 0 names the
 * platform it runs on (`uname -s` / `uname -m`): one universal macOS binary
 * (arm64 + x86_64, ad-hoc signed after lipo), and Linux x64 / arm64 (built on
 * Ubuntu 22.04: glibc 2.35, webkit2gtk-4.1). Each is the prefix plus its key.
 */
export const INSTALLER_BINARIES = {
  "macos-universal": `${INSTALLER_BINARY_PREFIX}macos-universal`,
  "linux-x64": `${INSTALLER_BINARY_PREFIX}linux-x64`,
  "linux-arm64": `${INSTALLER_BINARY_PREFIX}linux-arm64`,
} as const;

export type InstallerPlatform = keyof typeof INSTALLER_BINARIES;

/**
 * The release's other files. Published in two phases: the core files
 * (`script`, `manifest`, `sums`) first, all at once, and never changed after;
 * the installer binaries and `installerSums` attached later, once they are
 * built — `installerSums` last, so its presence means every binary it lists
 * is there.
 */
export const RELEASE_FILES = {
  /** The tag's install.sh: what stage 0 hands the install to. */
  script: "install.sh",
  /** {@link ReleaseManifest}. */
  manifest: "release.json",
  /**
   * `sha256sum` output (two spaces, then the name) over the core files:
   * `install.sh` and `release.json` (a v1 release: its binaries too).
   */
  sums: "SHA256SUMS",
  /**
   * `sha256sum` output over the installer binaries attached afterwards (a v2
   * release, `installers: 1`). Absent until they are attached — or for good,
   * when their build failed: stage 0 then installs in the terminal.
   */
  installerSums: "INSTALLER-SHA256SUMS",
} as const;

/**
 * The line install.sh carries when it can be run as a release's script —
 * started by stage 0 or the window with `--release <tag> --checkout <ref>`.
 * The workflow looks for it in the tag's install.sh to fill
 * `release.json`'s `handoff`; a release cut before it has none, and stage 0
 * then installs that release with its own (main's) steps instead.
 */
export const HANDOFF_MARKER = "# installer-handoff: 1";

/**
 * The line install.sh carries when it runs an install's steps after the
 * clone from the CHECKOUT's own install.sh (`--attach <run dir>`), so an
 * install of ref X always runs X's steps on X's code. Its number is the
 * install event protocol the attached script writes into the stream
 * ({@link INSTALL_PROTOCOL_VERSION}): a script hands over only to a checkout
 * carrying the same line, and stage 0 never lets a release whose script lacks
 * it install main.
 */
export const ATTACH_MARKER = `# installer-attach: ${INSTALL_PROTOCOL_VERSION}`;

/** The fields every `release.json` carries, whatever its version. */
const manifestBase = {
  /** The release tag (`v<YYYY.MM.DD>[.N]`). */
  tag: z.string().min(1),
  /** The commit the tag names. */
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  /** 1 when the release's install.sh accepts the hand-off (`HANDOFF_MARKER`). */
  handoff: z.literal(1).nullable(),
  /**
   * The install event protocol the release's install.sh speaks
   * (installer/core `INSTALL_PROTOCOL_VERSION`), null before it had one.
   */
  eventsProtocol: z.number().int().positive().nullable(),
};

/**
 * `release.json` v1: published with the binaries, all at once, so it listed
 * them. Releases cut before 2026-11-18; still read by stage 0.
 */
const ReleaseManifestV1 = z.object({
  v: z.literal(1),
  ...manifestBase,
  /**
   * The installer window's binary per platform; empty for a release cut
   * before the window existed (stage 0 then uses the terminal view).
   */
  assets: z.partialRecord(
    z.enum(Object.keys(INSTALLER_BINARIES) as [InstallerPlatform]),
    z.string(),
  ),
});

/**
 * `release.json` v2: published before the binaries are built, and never
 * changed after (a client reading it and `SHA256SUMS` on either side of a
 * rewrite would see a mismatch), so it names no binary. `installers: 1` says
 * they are attached separately, under their `INSTALLER_BINARIES` names and
 * verified by `RELEASE_FILES.installerSums`; null for a tag cut before the
 * window existed. A v1-only reader finds no platform key in it, and installs
 * in the terminal.
 */
export const ReleaseManifestV2 = z.object({
  v: z.literal(2),
  ...manifestBase,
  installers: z.literal(1).nullable(),
});
export type ReleaseManifestV2 = z.infer<typeof ReleaseManifestV2>;

/** `release.json`: what one release published. A reader refuses another `v`. */
export const ReleaseManifest = z.discriminatedUnion("v", [
  ReleaseManifestV1,
  ReleaseManifestV2,
]);
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;
