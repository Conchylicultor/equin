import { rmSync } from "node:fs";
import { join } from "node:path";
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { download } from "@plugins/infra/plugins/deps/plugins/download/deps";

/** apple-codesign (`rcodesign`) release, from indygreg/apple-platform-rs. */
const RCODESIGN_VERSION = "0.29.0";
const ARCHIVE = `apple-codesign-${RCODESIGN_VERSION}-macos-universal`;

/**
 * `rcodesign`: Apple code signing without the keychain. It signs a Mach-O
 * straight from a PEM key + certificate, so the local identity needs no
 * keychain on the user's search list and no trust settings — the two things
 * `/usr/bin/codesign` requires of a self-signed certificate (it rejects an
 * untrusted identity with "no identity found", whatever `--keychain` says).
 *
 * The pinned universal macOS release (one file for arm64 and x64; the binary
 * is itself Developer ID-signed by its author). Small, and awaited inside the
 * gateway's own install (`build`'s `then`), which already holds the caller's
 * background unit — so it skips admission rather than queue for a second one.
 */
export const rcodesign = defineDep({
  id: "rcodesign",
  owner: "infra/codesign",
  description:
    "rcodesign (apple-codesign): signs the gateway with the machine's local code-signing identity, without the keychain",
  sizeHint: "≈20 MB",
  source: download({
    files: [
      {
        name: `${ARCHIVE}.tar.gz`,
        url: `https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/${RCODESIGN_VERSION}/${ARCHIVE}.tar.gz`,
        sha256:
          "d98372d5524226ccf9dc0eda03d4e4f5826182dabb2fc3f2bd303ed9113a748d",
      },
    ],
    derive: {
      version: "1",
      outputs: ["rcodesign"],
      run: async (ctx) => {
        await ctx.run(
          [
            "tar",
            "-xzf",
            `${ARCHIVE}.tar.gz`,
            "--strip-components",
            "1",
            `${ARCHIVE}/rcodesign`,
          ],
          { cwd: ctx.dir, env: { ...process.env }, timeoutMs: 60_000 },
        );
        rmSync(join(ctx.dir, `${ARCHIVE}.tar.gz`));
      },
    },
    admission: {
      none: "one ~10 MB download awaited inside the gateway install, which already holds the caller's background unit",
    },
  }),
  updates: {
    none: "pinned release; bump RCODESIGN_VERSION and its sha256 by hand",
  },
});
