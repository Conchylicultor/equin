// The render loop and CLI every film script shares. A film script calls
// `runFilm({ name, out, flags, build })`; this parses the command line,
// builds and checks the composition, opens the film page, and either writes
// review stills or renders every frame (set t → two rAFs → CDP screenshot →
// ffmpeg stdin) under the mixed sound. Machine load changes how long a render
// takes, never the film.
//
//   --preview                  640×360 @ 30 fps (full: 1920×1080 @ 60 fps, stage at DPR 1.5)
//   --from <s> --to <s>        render a range (audio included, re-timed)
//   --stills t1,t2,…           one PNG per instant (full resolution unless --preview), no encode
//   --stills-out <dir>         where the stills go (default /tmp/film/<name>/stills)
//   --out <file.mp4>           output (default: the script's `out`, `-preview` before .mp4)
//   plus the film's own variant flags (`flags`), and the harness's --headed / --url.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { resolveFfmpeg } from "@plugins/media/plugins/ffmpeg/deps";
import { resolveMouseSounds } from "../../deps";
import {
  arg,
  flag,
  usage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { mixAudio } from "./audio";
import { checkComposition } from "./builders";
import type { Composition } from "./composition";
import { cuesInRange } from "./cues";
import { startEncoder } from "./encode";
import type { FilmWindowApi } from "./page/main";
import { serveFilm, STAGE_URL } from "./serve";

export interface FilmContext {
  preview: boolean;
  /** A variant flag the script declared in `flags` (throws on an undeclared name). */
  flag(name: string): boolean;
}

export interface FilmScript {
  /** Names the work dir and the default stills dir. */
  name: string;
  /** Full-render output path (`~` expands); a preview inserts `-preview` before the extension. */
  out: string;
  /** The film's own boolean variant flags: name → what it changes. */
  flags?: Record<string, string>;
  build(ctx: FilmContext): Composition | Promise<Composition>;
}

/** Flags the engine and the harness read; anything else on the command line is a typo. */
const ENGINE_FLAGS = ["preview", "from", "to", "stills", "stills-out", "out"];
const HARNESS_FLAGS = ["headed", "url", "composition", "no-record", "attach"];

const expandHome = (p: string): string => p.replace(/^~(?=\/|$)/, HOME_DIR);

export async function runFilm(script: FilmScript): Promise<void> {
  const declared = script.flags ?? {};
  const known = new Set([
    ...ENGINE_FLAGS,
    ...HARNESS_FLAGS,
    ...Object.keys(declared),
  ]);
  for (const tok of process.argv.slice(2)) {
    if (!tok.startsWith("--")) continue;
    const name = tok.slice(2).split("=")[0] ?? "";
    if (!known.has(name)) {
      const own = Object.entries(declared).map(([k, v]) => `  --${k}  ${v}`);
      usage(
        `unknown flag --${name}. Film flags: --preview --from <s> --to <s> --stills t1,t2 --stills-out <dir> --out <file>${own.length ? `\n${own.join("\n")}` : ""}`,
      );
    }
  }
  // The harness films every run unless told not to; a render's own frames are the film.
  if (!flag("no-record")) process.argv.push("--no-record");

  const preview = flag("preview");
  const comp = await script.build({
    preview,
    flag(name) {
      if (!(name in declared))
        throw new Error(
          `film: flag --${name} is not declared in the script's flags`,
        );
      return flag(name);
    },
  });
  checkComposition(comp);

  const from = Number(arg("from", "0"));
  const to = Number(arg("to", String(comp.duration)));
  if (!(from >= 0 && to > from && to <= comp.duration + 1e-6)) {
    usage(
      `bad range --from ${from} --to ${to} (the film is ${comp.duration.toFixed(2)} s)`,
    );
  }
  const stillsArg = arg("stills");
  const stills = stillsArg?.split(",").map((s) => Number(s.trim()));
  if (stills?.some((t) => !Number.isFinite(t) || t < 0 || t > comp.duration))
    usage(`bad --stills ${stillsArg}`);
  const work = join(tmpdir(), "film", script.name);
  mkdirSync(work, { recursive: true });

  const W = comp.width;
  const H = comp.height;
  const DPR = preview ? 0.5 : 1.5;
  const FPS = preview ? 30 : 60;
  const ff = stills ? null : await resolveFfmpeg();

  await withBrowser(async (h) => {
    const { page, context } = await h.session({
      viewport: { width: W, height: H },
      deviceScaleFactor: DPR,
      colorScheme: "dark",
      capture: false,
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const assertNoErrors = (): void => {
      if (errors.length)
        throw new Error(`film page error:\n${errors.join("\n")}`);
    };
    // The click is a recorded sound: installed only for a film that clicks.
    const samples: Record<string, string> = {};
    if (!stills && (comp.audio?.sfx ?? []).some((c) => c.kind === "click")) {
      const mouse = await resolveMouseSounds();
      samples["mouse-press.wav"] = mouse.press;
      samples["mouse-release.wav"] = mouse.release;
    }
    await serveFilm(page, comp, samples);
    await page.goto(STAGE_URL, { waitUntil: "load" });
    assertNoErrors();
    const t0 = Date.now();
    await page.evaluate(() =>
      (window as unknown as { __film: FilmWindowApi }).__film.ready(),
    );
    assertNoErrors();
    console.log(
      `film page ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
    const renderAt = (t: number): Promise<void> =>
      page.evaluate(
        (t) =>
          (window as unknown as { __film: FilmWindowApi }).__film.renderAt(t),
        t,
      );
    // A CDP session of our own does not inherit Playwright's emulation: give
    // it the same metrics, so its screenshots are in device pixels.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: W,
      height: H,
      deviceScaleFactor: DPR,
      mobile: false,
    });
    const shoot = async (format: "png" | "jpeg"): Promise<Buffer> => {
      const shot = (await cdp.send("Page.captureScreenshot", {
        format,
        ...(format === "jpeg" ? { quality: 93 } : {}),
        optimizeForSpeed: format === "jpeg",
      })) as { data: string };
      return Buffer.from(shot.data, "base64");
    };

    if (stills) {
      const dir = expandHome(
        arg("stills-out", join(tmpdir(), "film", script.name, "stills")),
      );
      mkdirSync(dir, { recursive: true });
      for (const t of stills) {
        await renderAt(t);
        assertNoErrors();
        const path = join(dir, `t${t.toFixed(2).padStart(6, "0")}.png`);
        writeFileSync(path, await shoot("png"));
        console.log(`  ${path}`);
      }
      return;
    }
    if (!ff)
      throw new Error("film: unreachable — ffmpeg not resolved for a render");

    // Sound first: the SFX bus synthesized in this page, then the mix.
    const dur = to - from;
    const cues = cuesInRange(comp.audio?.sfx ?? [], from, to);
    const wav = await page.evaluate(
      ([c, d]) =>
        (window as unknown as { __film: FilmWindowApi }).__film.renderSfx(c, d),
      [cues, dur] as const,
    );
    const sfxWav = join(work, "sfx.wav");
    writeFileSync(sfxWav, Buffer.from(wav, "base64"));
    console.log(`sfx: ${cues.length} cues → ${sfxWav}`);
    const audio = await mixAudio({
      comp,
      from,
      to,
      sfxWav,
      ffmpeg: ff.ffmpeg,
      work,
    });

    const defaultOut = preview
      ? script.out.replace(
          /(\.[a-z0-9]+)?$/i,
          (ext) => `-preview${ext || ".mp4"}`,
        )
      : script.out;
    const out = expandHome(arg("out", defaultOut));
    mkdirSync(dirname(out), { recursive: true });
    const width = Math.round(W * DPR);
    const height = Math.round(H * DPR);
    const enc = startEncoder({
      ffmpeg: ff.ffmpeg,
      out,
      fps: FPS,
      width,
      height,
      audio,
      duration: dur,
      preview,
    });

    const n = Math.round(dur * FPS);
    const started = Date.now();
    let nextLog = 0;
    for (let i = 0; i < n; i++) {
      const t = from + i / FPS;
      await renderAt(t);
      await enc.frame(await shoot("jpeg"));
      if (Date.now() - started >= nextLog) {
        assertNoErrors();
        const el = (Date.now() - started) / 1000;
        const eta = i > 0 ? (el / i) * (n - i) : 0;
        console.log(
          `  t=${t.toFixed(2)}s  frame ${i}/${n}  ${el.toFixed(0)} s elapsed, ~${eta.toFixed(0)} s left`,
        );
        nextLog += 10_000;
      }
    }
    assertNoErrors();
    await enc.finish();
    const secs = (Date.now() - started) / 1000;
    console.log(
      `wrote ${out} (${width}×${height} @ ${FPS} fps, ${dur.toFixed(2)} s): ${n} frames in ${secs.toFixed(1)} s, ${((secs / n) * 1000).toFixed(0)} ms/frame`,
    );
  });
}
