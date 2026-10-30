import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  defineDep,
  ensureDepViaCli,
  type Ready,
} from "@plugins/infra/plugins/deps/deps";
import {
  download,
  downloadedFile,
} from "@plugins/infra/plugins/deps/plugins/download/deps";

/** Martin Riedl's static macOS arm64 release builds (libx264, native aac, libopus). */
const BUILD = "1789931890_9.0.2";
const BASE = `https://ffmpeg.martin-riedl.de/download/macos/arm64/${BUILD}`;

/**
 * `ffmpeg` + `ffprobe`: a pinned static macOS arm64 release, so a film encodes
 * identically on every machine and needs no Homebrew.
 */
export const ffmpeg = defineDep({
  id: "ffmpeg",
  owner: "media/ffmpeg",
  description:
    "ffmpeg and ffprobe (static build with libx264 and aac): encodes films and verifies them",
  sizeHint: "≈160 MB",
  source: download({
    files: [
      {
        name: "ffmpeg.zip",
        url: `${BASE}/ffmpeg.zip`,
        sha256:
          "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
      },
      {
        name: "ffprobe.zip",
        url: `${BASE}/ffprobe.zip`,
        sha256:
          "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
      },
    ],
    derive: {
      version: "1",
      outputs: ["ffmpeg", "ffprobe"],
      run: async (ctx) => {
        for (const name of ["ffmpeg", "ffprobe"]) {
          await ctx.run(["unzip", "-o", `${name}.zip`, name], {
            cwd: ctx.dir,
            env: { ...process.env },
            timeoutMs: 120_000,
          });
          rmSync(join(ctx.dir, `${name}.zip`));
        }
      },
    },
    admission: {
      none: "two ~28 MB downloads fetched on demand by a film render, which already runs as an e2e op holding its host grant",
    },
  }),
  updates: {
    none: "pinned release; bump BUILD and both sha256 by hand",
  },
});

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

/** The installed binaries of a ready `ffmpeg` dep. */
export function ffmpegPaths(ready: Ready<typeof ffmpeg.source>): FfmpegPaths {
  return {
    ffmpeg: downloadedFile(ready, "ffmpeg"),
    ffprobe: downloadedFile(ready, "ffprobe"),
  };
}

/** Installs the `ffmpeg` dep when missing (a child `./equin deps install`) and returns its binaries. */
export async function resolveFfmpeg(): Promise<FfmpegPaths> {
  return ffmpegPaths(
    await ensureDepViaCli(ffmpeg, { stdio: "inherit", grant: null }),
  );
}
