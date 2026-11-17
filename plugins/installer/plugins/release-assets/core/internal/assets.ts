import { z } from "zod";

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
 * The installer window's binary per platform, keyed as stage 0 names the
 * platform it runs on (`uname -s` / `uname -m`): one universal macOS binary
 * (arm64 + x86_64, ad-hoc signed after lipo), and Linux x64 / arm64 (built on
 * Ubuntu 22.04: glibc 2.35, webkit2gtk-4.1).
 */
export const INSTALLER_BINARIES = {
  "macos-universal": "equin-installer-macos-universal",
  "linux-x64": "equin-installer-linux-x64",
  "linux-arm64": "equin-installer-linux-arm64",
} as const;

export type InstallerPlatform = keyof typeof INSTALLER_BINARIES;

/** The other files every release carries. */
export const RELEASE_FILES = {
  /** The tag's install.sh: what stage 0 hands the install to. */
  script: "install.sh",
  /** {@link ReleaseManifest}. */
  manifest: "release.json",
  /** `sha256sum` output over every other asset (two spaces, then the name). */
  sums: "SHA256SUMS",
} as const;

/**
 * The line install.sh carries when it can be run as a release's script —
 * started by stage 0 or the window with `--release <tag> --checkout <ref>`.
 * The workflow looks for it in the tag's install.sh to fill
 * `release.json`'s `handoff`; a release cut before it has none, and stage 0
 * then installs that release with its own (main's) steps instead.
 */
export const HANDOFF_MARKER = "# installer-handoff: 1";

/** `release.json`: what one release published. */
export const ReleaseManifest = z.object({
  /** This manifest's format. A reader refuses another major. */
  v: z.literal(1),
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
  /**
   * The installer window's binary per platform; empty for a release cut
   * before the window existed (stage 0 then uses the terminal view).
   */
  assets: z.partialRecord(
    z.enum(Object.keys(INSTALLER_BINARIES) as [InstallerPlatform]),
    z.string(),
  ),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;
