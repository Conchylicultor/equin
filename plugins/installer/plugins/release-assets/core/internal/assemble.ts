import { INSTALL_PROTOCOL_VERSION } from "@plugins/installer/core";
import { HANDOFF_MARKER, ReleaseManifestV2 } from "./assets";

/**
 * `release.json` (v2) for one tag, written before its installer binaries are
 * built: the tag's own install.sh, whose hand-off marker says whether stage 0
 * may run it, and whether binaries will be attached (`installers`: the tag
 * has the window's crate). Parsed through the schema, so a malformed manifest
 * is never published.
 */
export function releaseManifest(input: {
  tag: string;
  commit: string;
  script: string;
  installers: boolean;
}): ReleaseManifestV2 {
  const handoff = input.script.split("\n").includes(HANDOFF_MARKER);
  return ReleaseManifestV2.parse({
    v: 2,
    tag: input.tag,
    commit: input.commit,
    handoff: handoff ? 1 : null,
    // The hand-off and the event stream shipped together: a script that
    // accepts one speaks the other.
    eventsProtocol: handoff ? INSTALL_PROTOCOL_VERSION : null,
    installers: input.installers ? 1 : null,
  });
}

/**
 * `SHA256SUMS` / `INSTALLER-SHA256SUMS`: `sha256sum`'s own format (hash, two
 * spaces, name), sorted by name, so `shasum -a 256 -c` / `sha256sum -c` read it as is.
 */
export function sha256Sums(
  files: readonly { name: string; sha256: string }[],
): string {
  return [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => {
      if (!/^[0-9a-f]{64}$/.test(f.sha256))
        throw new Error(`not a sha256 for ${f.name}: ${f.sha256}`);
      if (/[\s/]/.test(f.name))
        throw new Error(`an asset name must be one plain word: ${f.name}`);
      return `${f.sha256}  ${f.name}\n`;
    })
    .join("");
}
