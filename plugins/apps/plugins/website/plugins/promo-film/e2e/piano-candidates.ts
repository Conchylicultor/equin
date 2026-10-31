// Auditions candidate piano pieces for the film: each MIDI is opened the way
// the film opens its own (Files → "Open in Sonata", which imports it), Sonata
// plays it from the given bar, and its real piano sound — the same capture as
// the film's (`internal/sonata-audio.ts`) — is saved as an mp3 to listen to.
//
//   ./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/piano-candidates.ts \
//     --composition promo-film --candidates /abs/a.mid:65,/abs/b.mid:38 \
//     --out ~/Downloads/showcase/piano-candidates [--seconds 10]
//
// The MIDIs are copied into the film's workspace folder (rewritten by every
// seed), next to the practice file, so Files can open them.

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { resolveFfmpeg } from "@plugins/media/plugins/ffmpeg/deps";
import { promoFilmWorkspaceDir } from "@plugins/apps/plugins/website/plugins/promo-film/plugins/seed/data-dirs";
import {
  arg,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { open, visible } from "./internal/session-kit";
import { recordSonataAudio } from "./internal/sonata-audio";

const expandHome = (p: string): string => p.replace(/^~(?=\/|$)/, HOME_DIR);
const USAGE =
  "piano-candidates.ts --composition promo-film --candidates <a.mid>:<bar>,… --out <dir> [--seconds 10]";
const candidates = requireArg("candidates", USAGE)
  .split(",")
  .map((c) => {
    const at = c.lastIndexOf(":");
    const bar = Number(c.slice(at + 1));
    if (at < 0 || !Number.isInteger(bar) || bar < 1)
      throw new Error(`--candidates: "${c}" is not <file.mid>:<bar>`);
    return { midi: expandHome(c.slice(0, at)), bar };
  });
const outDir = expandHome(requireArg("out", USAGE));
const seconds = Number(arg("seconds", "10"));
mkdirSync(outDir, { recursive: true });

const folder = promoFilmWorkspaceDir.file("candidates");
rmSync(folder, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
const ff = await resolveFfmpeg();

await withBrowser(async (h) => {
  for (const c of candidates) {
    const name = basename(c.midi);
    copyFileSync(c.midi, join(folder, name));
    // Files → the MIDI preview → "Open in Sonata" (the import), as a user does.
    const { page, context } = await h.session({ capture: false });
    const dir = encodeURIComponent(folder.replace(HOME_DIR, "~"));
    await open(page, `/files/at/${dir}/${encodeURIComponent(name)}`);
    const toSonata = page.getByRole("button", { name: "Open in Sonata" });
    await visible(toSonata, 60_000);
    await toSonata.first().click();
    await page.waitForURL(/\/sonata\/song\//, { timeout: 60_000 });
    const song = new URL(page.url()).pathname.replace(/;bar=\d+$/, "");
    await context.close();
    const wav = join(outDir, `${name.replace(/\.mid$/, "")}.wav`);
    const clip = await recordSonataAudio(h, `${song};bar=${c.bar}`, {
      seconds,
      out: wav,
    });
    const mp3 = wav.replace(/\.wav$/, ".mp3");
    const proc = Bun.spawn(
      [ff.ffmpeg, "-v", "error", "-y", "-i", wav, "-b:a", "192k", mp3],
      { stderr: "pipe" },
    );
    if ((await proc.exited) !== 0)
      throw new Error(
        `piano-candidates: mp3 encode failed: ${await new Response(proc.stderr).text()}`,
      );
    rmSync(wav);
    console.log(
      `${mp3}  (${name}, from bar ${c.bar}, ${clip.duration.toFixed(1)} s)`,
    );
  }
});
