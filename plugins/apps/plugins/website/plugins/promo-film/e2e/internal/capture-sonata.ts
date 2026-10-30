// Sonata playing: a still, a 30 fps timed sequence of the piano roll mid
// playback, and the sound of the same passage.
//
// The sequence: the tempo is set to its slowest preset (25%, local to the page
// — the persisting write is refused on main) so a 2x screenshot (~150 ms)
// advances the music by less than a 30 fps frame; the frames taken are then
// resampled by wall-clock time onto an exact 1/30 s media grid.
//
// The sound: every node connected to an AudioContext's destination is also
// connected to a script-processor tap that records the PCM (Sonata's own
// sampled grand piano, via smplr), while the passage plays at 100% from the
// same bar. The WAV is trimmed to its first audible onset.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  type Ctx,
  H,
  W,
  hideBar,
  measure,
  open,
  park,
  rect,
  shot,
  sweepNoise,
} from "./capture-kit";
import { SONG } from "./capture-home-chain";

const BAR = 12;
const SEQ_SECONDS = 3;
const FPS = 30;
const DPR_OUT = 1;
const TEMPO = 0.25;

const PATH = `/sonata/song/${SONG};bar=${BAR}`;

async function ready(c: Ctx): Promise<void> {
  const p = c.page;
  await open(p, PATH, { settleMs: 2000 });
  await p
    .getByRole("button", { name: "Play", exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 90_000 });
  await p.waitForTimeout(2500);
  // The Song side panel is closed by its X (top right of the panel).
  if (
    await p.getByText("Circle of fifths", { exact: true }).first().isVisible()
  )
    await p.mouse.click(1244, 88);
  await p.mouse.move(W / 2, 30);
  await p.waitForTimeout(800);
  await hideBar(p);
  await sweepNoise(p);
}

const play = (p: Page) =>
  p.getByRole("button", { name: "Play", exact: true }).first().click();

export async function sonataStill(c: Ctx): Promise<void> {
  await ready(c);
  await shot(c, "sonata");
  await rect(c, "sonata-toolbar", () => {
    let n: Element | null =
      Array.from(document.querySelectorAll("*")).find((b) =>
        Array.from(b.childNodes).some(
          (n) => n.nodeType === 3 && /Piano roll/.test(n.nodeValue ?? ""),
        ),
      ) ?? null;
    while (n && n.getBoundingClientRect().width < 400) n = n.parentElement;
    return n;
  });
  await rect(c, "sonata-transport", () => {
    let n: Element | null =
      Array.from(document.querySelectorAll("button")).find((b) =>
        /^(play|pause)$/i.test(
          b.getAttribute("aria-label") ??
            b.getAttribute("title") ??
            b.textContent ??
            "",
        ),
      ) ?? null;
    while (n && n.getBoundingClientRect().width < 700) n = n.parentElement;
    return n;
  });
  c.manifest.rects["sonata-keyboard"] = {
    x: 0,
    y: 630,
    width: W,
    height: H - 630,
  };
  c.manifest.rects["sonata-roll"] = { x: 0, y: 0, width: W, height: 630 };
}

export async function sonataSequence(c: Ctx): Promise<void> {
  const p = c.page;
  await ready(c);
  // Tempo 25% (local: the persisting write is refused on main): the page renders ~5 fps headless,
  // so the music is slowed 4x and the frames are mapped back to media time.
  await p.getByText("100%", { exact: true }).first().click();
  await p.getByText("25%", { exact: true }).first().click();
  await p.waitForTimeout(500);
  await park(p);
  // CDP screencast: the compositor's own frames with media timestamps, at the real tempo
  // (a screenshot per frame costs ~1.6 s at 2x; the screencast delivers 30+ fps).
  const cdp = await c.context.newCDPSession(p);
  const raw: Array<{ t: number; jpg: Buffer }> = [];
  cdp.on(
    "Page.screencastFrame",
    (e: {
      data: string;
      metadata: { timestamp?: number };
      sessionId: number;
    }) => {
      raw.push({
        t: e.metadata.timestamp ?? Date.now() / 1000,
        jpg: Buffer.from(e.data, "base64"),
      });
      void cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId });
    },
  );
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 88,
    maxWidth: W * DPR_OUT,
    maxHeight: H * DPR_OUT,
    everyNthFrame: 1,
  });
  await p.waitForTimeout(600);
  const tClick = Date.now() / 1000;
  await play(p);
  await p.waitForTimeout((SEQ_SECONDS / TEMPO + 1.5) * 1000);
  await cdp.send("Page.stopScreencast");
  await p.getByRole("button", { name: "Pause", exact: true }).first().click();
  const after = raw.filter((f) => f.t >= tClick);
  if (after.length < SEQ_SECONDS * 15 * TEMPO)
    throw new Error(
      `sonata sequence: only ${after.length} screencast frames after Play`,
    );
  const rate = after.length / (after.at(-1)!.t - after[0]!.t);
  // Media 0 is the first frame whose picture differs from the paused one (the playhead has started).
  const start = after[0]!.t + 0.15;
  const frames: string[] = [];
  let worst = 0;
  for (let k = 0; k < SEQ_SECONDS * FPS; k++) {
    const target = start + k / FPS / TEMPO;
    let best = after[0]!;
    for (const f of after)
      if (Math.abs(f.t - target) < Math.abs(best.t - target)) best = f;
    worst = Math.max(worst, Math.abs(best.t - target));
    const file = `sonata-play-${String(k).padStart(3, "0")}.jpg`;
    writeFileSync(join(c.out, file), best.jpg);
    frames.push(file);
  }
  console.log(
    `  sonata sequence: ${after.length} screencast frames (${rate.toFixed(1)}/s), ${frames.length} resampled to ${FPS} fps, worst nearest-frame error ${Math.round(worst * 1000)} ms`,
  );
  c.manifest.sequences["sonata-play"] = {
    frames,
    clip: { x: 0, y: 0, width: W, height: H },
    fps: FPS,
  };
}

const TAP = `(() => {
  const state = { chunks: [], sr: 0, on: false };
  window.__tap = state;
  const taps = new WeakMap();
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = orig.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode) {
      const ctx = dest.context;
      let tap = taps.get(ctx);
      if (!tap) {
        const sp = ctx.createScriptProcessor(4096, 2, 2);
        const mute = ctx.createGain();
        mute.gain.value = 0;
        sp.onaudioprocess = (e) => {
          if (!state.on) return;
          state.sr = ctx.sampleRate;
          state.chunks.push([new Float32Array(e.inputBuffer.getChannelData(0)), new Float32Array(e.inputBuffer.getChannelData(1))]);
        };
        orig.call(sp, mute);
        orig.call(mute, dest);
        taps.set(ctx, (tap = sp));
      }
      if (this !== tap) orig.call(this, tap);
    }
    return r;
  };
})();`;

function wav(left: Float32Array, right: Float32Array, sr: number): Buffer {
  const n = left.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 4, 40);
  const s = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(s(left[i]!), 44 + i * 4);
    buf.writeInt16LE(s(right[i]!), 46 + i * 4);
  }
  return buf;
}

export async function sonataAudio(c: Ctx): Promise<void> {
  await c.context.addInitScript(TAP);
  const p = c.page;
  await ready(c);
  await p.evaluate(
    () => ((window as unknown as { __tap: { on: boolean } }).__tap.on = true),
  );
  await play(p);
  await p.waitForTimeout(9000);
  await p.getByRole("button", { name: "Pause", exact: true }).first().click();
  const raw = await p.evaluate(() => {
    const t = (
      window as unknown as {
        __tap: { on: boolean; sr: number; chunks: Float32Array[][] };
      }
    ).__tap;
    t.on = false;
    const n = t.chunks.reduce((a, ch) => a + ch[0]!.length, 0);
    const out = new Float32Array(n * 2);
    let o = 0;
    for (const ch of t.chunks) {
      out.set(ch[0]!, o);
      out.set(ch[1]!, n + o);
      o += ch[0]!.length;
    }
    let bin = "";
    const bytes = new Uint8Array(out.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { sr: t.sr, n, b64: btoa(bin) };
  });
  if (raw.n === 0)
    throw new Error(
      "sonata audio: the tap recorded nothing (no AudioContext reached its destination)",
    );
  const all = new Float32Array(Buffer.from(raw.b64, "base64").buffer.slice(0));
  const left = all.subarray(0, raw.n);
  const right = all.subarray(raw.n);
  const win = Math.round(raw.sr * 0.01);
  let onset = -1;
  for (let i = 0; i + win < raw.n; i += win) {
    let e = 0;
    for (let j = 0; j < win; j++) e += left[i + j]! ** 2 + right[i + j]! ** 2;
    if (Math.sqrt(e / (2 * win)) > 0.004) {
      onset = i;
      break;
    }
  }
  if (onset < 0)
    throw new Error(
      "sonata audio: the recording is silent (samples not loaded or audio muted)",
    );
  const start = Math.max(0, onset - Math.round(raw.sr * 0.03));
  const len = Math.min(raw.n - start, Math.round(raw.sr * 4.5));
  const file = "audio-sonata.wav";
  writeFileSync(
    join(c.out, file),
    wav(
      left.slice(start, start + len),
      right.slice(start, start + len),
      raw.sr,
    ),
  );
  c.manifest.audio.sonata = { file, duration: len / raw.sr };
  console.log(
    `  audio.sonata: ${(len / raw.sr).toFixed(2)} s at ${raw.sr} Hz (first onset ${(onset / raw.sr).toFixed(2)} s after Play; trimmed to it)`,
  );
  void measure;
}
