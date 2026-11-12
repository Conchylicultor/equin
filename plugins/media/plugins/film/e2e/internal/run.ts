// The render loop and CLI every film script shares. A film script calls
// `runFilm({ name, out, flags, build })`; this parses the command line,
// builds and checks the composition, opens the film page, and either writes
// review stills or renders every frame (set t → two rAFs → CDP screenshot →
// ffmpeg stdin) under the mixed sound. Machine load changes how long a render
// takes, never the film.
//
// A render is parallel: the frames split into contiguous ranges (film/core's
// splitFrames), each rendered by its own page into its own H.264 chunk at
// once, the chunks then joined losslessly (concat demuxer, -c:v copy) under
// the audio mixed once for the whole film. Frame i shows the same instant
// whichever page renders it, and renderAt(t) is a pure function of t, so the
// pictures are the serial render's.
//
//   --preview                  640×360 @ 30 fps (full: 1920×1080 @ 60 fps, stage at DPR 1.5)
//   --from <s> --to <s>        render a range (audio included, re-timed)
//   --stills t1,t2,…           one PNG per instant (full resolution unless --preview), no encode
//   --stills-out <dir>         where the stills go (default /tmp/film/<name>/stills)
//   --out <file.mp4>           output (default: the script's `out`, `-preview` before .mp4)
//   --workers <n>              pages rendering at once (default: from the host's cores; 1 = serial)
//   plus the film's own variant flags (`flags`) and valued options (`options`,
//   `--<name> <value>`), and the harness's --headed / --url.

import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Page } from "playwright";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { resolveFfmpeg } from "@plugins/media/plugins/ffmpeg/deps";
import { resolveMouseSounds } from "../../deps";
import {
  defaultWorkers,
  frameCount,
  frameTime,
  splitFrames,
  type FrameRange,
} from "../../core";
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
import {
  chunkEncoderArgs,
  concatArgs,
  concatList,
  encoderArgs,
  runFfmpeg,
  startEncoder,
  webEncodeArgs,
  type Encoder,
} from "./encode";
import type { FilmWindowApi } from "./page/main";
import { filmServer, STAGE_URL } from "./serve";

export interface FilmContext {
  preview: boolean;
  /** A variant flag the script declared in `flags` (throws on an undeclared name). */
  flag(name: string): boolean;
  /** A valued option the script declared in `options`, or `undefined` when absent (throws on an undeclared name). */
  option(name: string): string | undefined;
}

export interface FilmScript {
  /** Names the work dir and the default stills dir. */
  name: string;
  /**
   * Output path (`~` expands): a fixed path (a preview inserts `-preview`
   * before the extension), or a function of the render (a script that
   * versions its outputs). Whatever it answers, a render never writes over an
   * existing file: it refuses before rendering.
   */
  out: string | ((ctx: FilmContext) => string);
  /** The film's own boolean variant flags: name → what it changes. */
  flags?: Record<string, string>;
  /** The film's own valued options (`--<name> <value>`): name → what it sets. */
  options?: Record<string, string>;
  build(ctx: FilmContext): Composition | Promise<Composition>;
  /**
   * Also write a light web version beside every full (non-preview) render:
   * `<out>-web.mp4` (encode.ts `webEncodeArgs` — the size a page can stream),
   * transcoded from the finished film, under the same never-overwrite rule
   * (refused before rendering when it exists).
   */
  web?: true;
}

/** Flags the engine and the harness read; anything else on the command line is a typo. */
const ENGINE_FLAGS = [
  "preview",
  "from",
  "to",
  "stills",
  "stills-out",
  "out",
  "workers",
];
const HARNESS_FLAGS = ["headed", "url", "composition", "no-record", "attach"];

const expandHome = (p: string): string => p.replace(/^~(?=\/|$)/, HOME_DIR);

const stillsRequested = (): boolean => arg("stills") !== undefined;

export async function runFilm(script: FilmScript): Promise<void> {
  const declared = script.flags ?? {};
  const declaredOptions = script.options ?? {};
  const known = new Set([
    ...ENGINE_FLAGS,
    ...HARNESS_FLAGS,
    ...Object.keys(declared),
    ...Object.keys(declaredOptions),
  ]);
  for (const tok of process.argv.slice(2)) {
    if (!tok.startsWith("--")) continue;
    const name = tok.slice(2).split("=")[0] ?? "";
    if (!known.has(name)) {
      const own = [
        ...Object.entries(declared).map(([k, v]) => `  --${k}  ${v}`),
        ...Object.entries(declaredOptions).map(
          ([k, v]) => `  --${k} <value>  ${v}`,
        ),
      ];
      usage(
        `unknown flag --${name}. Film flags: --preview --from <s> --to <s> --stills t1,t2 --stills-out <dir> --out <file>${own.length ? `\n${own.join("\n")}` : ""}`,
      );
    }
  }
  // The harness films every run unless told not to; a render's own frames are the film.
  if (!flag("no-record")) process.argv.push("--no-record");

  const preview = flag("preview");
  const ctx: FilmContext = {
    preview,
    flag(name) {
      if (!(name in declared))
        throw new Error(
          `film: flag --${name} is not declared in the script's flags`,
        );
      return flag(name);
    },
    option(name) {
      if (!(name in declaredOptions))
        throw new Error(
          `film: option --${name} is not declared in the script's options`,
        );
      const value = arg(name);
      if (value === "")
        usage(`film: --${name} needs a value (${declaredOptions[name]})`);
      return value;
    },
  };
  const comp = await script.build(ctx);
  checkComposition(comp);

  const defaultOut =
    typeof script.out === "function"
      ? script.out(ctx)
      : preview
        ? script.out.replace(
            /(\.[a-z0-9]+)?$/i,
            (ext) => `-preview${ext || ".mp4"}`,
          )
        : script.out;
  const out = expandHome(arg("out", defaultOut));
  // A film is a version: a render never replaces one (no flag turns this off).
  if (!stillsRequested() && existsSync(out))
    usage(
      `film: ${out} already exists — a render never writes over a film. Render to a new name (--out), or let the script pick its next version.`,
    );

  // The web version rides on every full render of a film that wants one.
  const webOut =
    script.web && !preview && !stillsRequested() ? webVersionOf(out) : null;
  if (webOut && existsSync(webOut))
    usage(
      `film: ${webOut} already exists — a render never writes over a film (its web version included).`,
    );

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
  const workersArg = arg("workers");
  const workers =
    workersArg === undefined
      ? defaultWorkers(availableParallelism())
      : Number(workersArg);
  if (!Number.isInteger(workers) || workers < 1)
    usage(`bad --workers ${workersArg} (a positive integer)`);
  const work = join(tmpdir(), "film", script.name);
  mkdirSync(work, { recursive: true });

  const W = comp.width;
  const H = comp.height;
  const DPR = preview ? 0.5 : 1.5;
  const FPS = preview ? 30 : 60;
  const ff = stills ? null : await resolveFfmpeg();

  await withBrowser(async (h) => {
    // The click is a recorded sound: installed only for a film that clicks.
    const samples: Record<string, string> = {};
    if (!stills && (comp.audio?.sfx ?? []).some((c) => c.kind === "click")) {
      const mouse = await resolveMouseSounds();
      samples["mouse-press.wav"] = mouse.press;
      samples["mouse-release.wav"] = mouse.release;
    }
    const server = await filmServer(comp, samples);

    /** A film page, ready: every image decoded, every font loaded. */
    const openPage = async (): Promise<FilmPage> => {
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
      await server.serve(page);
      await page.goto(STAGE_URL, { waitUntil: "load" });
      assertNoErrors();
      await page.evaluate(() =>
        (window as unknown as { __film: FilmWindowApi }).__film.ready(),
      );
      assertNoErrors();
      // A CDP session of our own does not inherit Playwright's emulation: give
      // it the same metrics, so its screenshots are in device pixels.
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: W,
        height: H,
        deviceScaleFactor: DPR,
        mobile: false,
      });
      return {
        page,
        assertNoErrors,
        renderAt: (t) =>
          page.evaluate(
            (t) =>
              (window as unknown as { __film: FilmWindowApi }).__film.renderAt(
                t,
              ),
            t,
          ),
        async shoot(format) {
          const shot = (await cdp.send("Page.captureScreenshot", {
            format,
            ...(format === "jpeg" ? { quality: 93 } : {}),
            optimizeForSpeed: format === "jpeg",
          })) as { data: string };
          return Buffer.from(shot.data, "base64");
        },
      };
    };

    const t0 = Date.now();
    const first = await openPage();
    console.log(
      `film page ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );

    if (stills) {
      const dir = expandHome(
        arg("stills-out", join(tmpdir(), "film", script.name, "stills")),
      );
      mkdirSync(dir, { recursive: true });
      for (const t of stills) {
        await first.renderAt(t);
        first.assertNoErrors();
        const path = join(dir, `t${t.toFixed(2).padStart(6, "0")}.png`);
        writeFileSync(path, await first.shoot("png"));
        console.log(`  ${path}`);
      }
      return;
    }
    if (!ff)
      throw new Error("film: unreachable — ffmpeg not resolved for a render");

    // Sound first: the SFX bus synthesized in this page, then the mix.
    const dur = to - from;
    const cues = cuesInRange(comp.audio?.sfx ?? [], from, to);
    const wav = await first.page.evaluate(
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

    mkdirSync(dirname(out), { recursive: true });
    const video = {
      ffmpeg: ff.ffmpeg,
      fps: FPS,
      width: Math.round(W * DPR),
      height: Math.round(H * DPR),
      preview,
    };
    const n = frameCount(dur, FPS);
    const ranges = splitFrames(n, workers, MIN_CHUNK_SECONDS * FPS);
    const started = Date.now();
    let done = 0;
    let nextLog = 0;
    const progress = (): void => {
      done++;
      if (Date.now() - started < nextLog) return;
      const el = (Date.now() - started) / 1000;
      const eta = done > 0 ? (el / done) * (n - done) : 0;
      console.log(
        `  frame ${done}/${n}  ${el.toFixed(0)} s elapsed, ~${eta.toFixed(0)} s left`,
      );
      nextLog += 10_000;
    };
    /** Render `range` on `p` into `enc`, stopping early once `stop()` says so. */
    const renderRange = async (
      p: FilmPage,
      range: FrameRange,
      enc: Encoder,
      stop: () => boolean,
    ): Promise<void> => {
      for (let i = range.start; i < range.end; i++) {
        if (stop()) throw new ChunkStopped();
        await p.renderAt(frameTime(from, i, FPS));
        await enc.frame(await p.shoot("jpeg"));
        p.assertNoErrors();
        progress();
      }
      await enc.finish();
    };

    // Everything is written beside the output and only linked to its name
    // once complete: a failed render leaves nothing at `out`, and the link
    // refuses (EEXIST) a file that appeared there meanwhile — never an overwrite.
    const partial = join(
      dirname(out),
      `.${basename(out)}.partial-${process.pid}.mp4`,
    );
    try {
      const only = ranges[0];
      if (ranges.length === 1 && only) {
        console.log(`render: ${n} frames on 1 page`);
        const enc = startEncoder(
          ff.ffmpeg,
          encoderArgs({ ...video, out: partial, audio, duration: dur }),
          partial,
        );
        try {
          await renderRange(first, only, enc, () => false);
        } catch (err) {
          enc.abort();
          throw err;
        }
      } else {
        await renderParallel({
          ranges,
          first,
          openPage,
          renderRange,
          startChunk: (file) =>
            startEncoder(
              ff.ffmpeg,
              chunkEncoderArgs({ ...video, out: file }),
              file,
            ),
          join: (list) =>
            runFfmpeg(
              ff.ffmpeg,
              concatArgs({ list, audio, duration: dur, out: partial }),
              `joining the chunks into ${partial}`,
            ),
        });
      }
      linkSync(partial, out);
    } finally {
      rmSync(partial, { force: true });
    }
    const secs = (Date.now() - started) / 1000;
    console.log(
      `wrote ${out} (${video.width}×${video.height} @ ${FPS} fps, ${dur.toFixed(2)} s): ${n} frames on ${ranges.length} page(s) in ${secs.toFixed(1)} s, ${((secs / n) * 1000).toFixed(0)} ms/frame`,
    );
    if (webOut) await writeWebVersion(ff.ffmpeg, out, webOut);
  });
}

/** `<name>-web.mp4` beside `<name>.mp4`: the film's web version. */
function webVersionOf(out: string): string {
  return out.replace(/(\.[a-z0-9]+)?$/i, () => "-web.mp4");
}

/**
 * The web version of a finished film (`webEncodeArgs`), written beside it
 * and linked to its name only once complete — never over an existing file.
 */
async function writeWebVersion(
  ffmpeg: string,
  film: string,
  webOut: string,
): Promise<void> {
  const partial = join(
    dirname(webOut),
    `.${basename(webOut)}.partial-${process.pid}.mp4`,
  );
  const started = Date.now();
  try {
    await runFfmpeg(
      ffmpeg,
      webEncodeArgs({ input: film, out: partial }),
      `writing the web version ${webOut}`,
    );
    linkSync(partial, webOut);
  } finally {
    rmSync(partial, { force: true });
  }
  console.log(
    `wrote ${webOut} (web version, ${(statSync(webOut).size / 1e6).toFixed(1)} MB) in ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
}

/** Under this much film a chunk costs more (its page's start-up) than it saves. */
const MIN_CHUNK_SECONDS = 2;

/** A ready film page. */
interface FilmPage {
  page: Page;
  renderAt(t: number): Promise<void>;
  shoot(format: "png" | "jpeg"): Promise<Buffer>;
  assertNoErrors(): void;
}

/** A chunk that stopped because another one failed (not itself a cause). */
class ChunkStopped extends Error {
  constructor() {
    super("film: chunk stopped — another chunk failed");
  }
}

/**
 * Render `ranges` at once, one page and one encoder per range, into chunk
 * files in a temp dir, then `join` them. The first failure stops every other
 * chunk (their encoders killed, their loops ending at the next frame) and is
 * what this throws; the temp dir is removed either way.
 */
async function renderParallel(o: {
  ranges: FrameRange[];
  first: FilmPage;
  openPage(): Promise<FilmPage>;
  renderRange(
    p: FilmPage,
    range: FrameRange,
    enc: Encoder,
    stop: () => boolean,
  ): Promise<void>;
  startChunk(file: string): Encoder;
  join(list: string): Promise<void>;
}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "film-chunks-"));
  try {
    const t0 = Date.now();
    const pages = [
      o.first,
      ...(await Promise.all(o.ranges.slice(1).map(() => o.openPage()))),
    ];
    console.log(
      `render: ${o.ranges.at(-1)?.end} frames on ${o.ranges.length} pages (${o.ranges.map((r) => r.end - r.start).join(" + ")}), pages ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
    const files = o.ranges.map((_, k) =>
      join(dir, `chunk-${String(k).padStart(3, "0")}.mp4`),
    );
    const encoders: Encoder[] = [];
    // The first failure, the cause; every other chunk then stops.
    const failures: unknown[] = [];
    const results = await Promise.allSettled(
      o.ranges.map(async (range, k) => {
        const enc = o.startChunk(files[k] as string);
        encoders.push(enc);
        try {
          await o.renderRange(
            pages[k] as FilmPage,
            range,
            enc,
            () => failures.length > 0,
          );
        } catch (err) {
          failures.push(err);
          if (failures.length === 1) for (const e of encoders) e.abort();
          else enc.abort();
          throw err;
        }
      }),
    );
    if (failures.length > 0) throw failures[0];
    // Unreachable with no failure recorded; asserted so a settled rejection can never pass.
    if (results.some((r) => r.status === "rejected"))
      throw new Error("film: a chunk rejected without a recorded failure");
    const list = join(dir, "chunks.txt");
    writeFileSync(list, concatList(files));
    await o.join(list);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
