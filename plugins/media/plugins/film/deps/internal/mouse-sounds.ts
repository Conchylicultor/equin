import { renameSync, rmSync } from "node:fs";
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

const ZIP = "UI_SFX_Set.zip";

/**
 * The film's mouse click: a real recorded mouse button press and release from
 * Kenney's "51 UI sound effects (buttons, switches and clicks)" set, CC0 1.0
 * (https://creativecommons.org/publicdomain/zero/1.0/; credit www.kenney.nl
 * welcome, not required). Source page:
 * https://opengameart.org/content/51-ui-sound-effects-buttons-switches-and-clicks
 * The zip is pinned by sha256; only `mouseclick1.wav` / `mouserelease1.wav`
 * are kept (44.1 kHz stereo, ~60 ms each, peaks near -31 dBFS).
 */
export const mouseSounds = defineDep({
  id: "film-mouse-sounds",
  owner: "media/film",
  description:
    "a real mouse click (press + release) from Kenney's CC0 UI SFX set, the film engine's click sound",
  sizeHint: "≈1.4 MB download, ≈25 KB kept",
  source: download({
    files: [
      {
        name: ZIP,
        url: "https://opengameart.org/sites/default/files/UI_SFX_Set.zip",
        sha256:
          "66026b9e39859b85964dbb3ee7a2d1fc46a6a406bb3e97c8b0defee0e25fb369",
      },
    ],
    derive: {
      version: "1",
      outputs: ["mouse-press.wav", "mouse-release.wav"],
      run: async (ctx) => {
        for (const [from, to] of [
          ["mouseclick1.wav", "mouse-press.wav"],
          ["mouserelease1.wav", "mouse-release.wav"],
        ] as const) {
          await ctx.run(["unzip", "-o", ZIP, from], {
            cwd: ctx.dir,
            env: { ...process.env },
            timeoutMs: 60_000,
          });
          renameSync(join(ctx.dir, from), join(ctx.dir, to));
        }
        rmSync(join(ctx.dir, ZIP));
      },
    },
    admission: {
      none: "one 1.4 MB download fetched on demand by a film render, which already runs as an e2e op",
    },
  }),
  updates: {
    none: "pinned recording; another click sound is a deliberate swap by hand",
  },
});

/** The installed press / release WAVs of a ready `film-mouse-sounds` dep. */
export function mouseSoundFiles(ready: Ready<typeof mouseSounds.source>): {
  press: string;
  release: string;
} {
  return {
    press: downloadedFile(ready, "mouse-press.wav"),
    release: downloadedFile(ready, "mouse-release.wav"),
  };
}

/** Installs the mouse sounds when missing (a child `./equin deps install`) and returns their paths. */
export async function resolveMouseSounds(): Promise<{
  press: string;
  release: string;
}> {
  return mouseSoundFiles(
    await ensureDepViaCli(mouseSounds, { stdio: "inherit", grant: null }),
  );
}
