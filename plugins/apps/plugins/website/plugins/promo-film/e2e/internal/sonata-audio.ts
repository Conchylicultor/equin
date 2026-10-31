// Sonata's own sound for the film: the recording's pictures run on a virtual
// clock, so the piano is captured separately, in real time — the same song
// from the same bar, Play pressed, every node that reaches an AudioContext's
// destination tapped (Sonata's sampled grand piano, via smplr) — and the film
// places its first note where the recording's playhead starts moving.
// Trimmed to its first onset.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { AudioClip } from "@plugins/media/plugins/film/e2e";
import { DPR, H, open, REC_DIR, visible, W } from "./session-kit";

/** How much of the passage the film may use (default). */
const FILM_SECONDS = 9;

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
    buf.writeInt16LE(s(left[i] ?? 0), 44 + i * 4);
    buf.writeInt16LE(s(right[i] ?? 0), 46 + i * 4);
  }
  return buf;
}

/**
 * Record Sonata playing `path` (a song route, `;bar=N` to start at a bar) as
 * a WAV: by default the film's clip (`sonata-piano.wav` + its metadata in the
 * recording dir), or `opts.out` (an absolute .wav path, nothing else written).
 */
export async function recordSonataAudio(
  h: Harness,
  path: string,
  opts: { seconds?: number; out?: string } = {},
): Promise<AudioClip> {
  const SECONDS = opts.seconds ?? FILM_SECONDS;
  const { page, context } = await h.session({
    viewport: { width: W, height: H },
    deviceScaleFactor: DPR,
    colorScheme: "dark",
    capture: false,
  });
  await context.addInitScript(TAP);
  await open(page, path);
  const play = page.getByRole("button", { name: "Play", exact: true }).first();
  await visible(play, 90_000);
  await page.waitForTimeout(2500);
  await page.evaluate(
    () => ((window as unknown as { __tap: { on: boolean } }).__tap.on = true),
  );
  await play.click();
  await page.waitForTimeout((SECONDS + 1.5) * 1000);
  const raw = await page.evaluate(() => {
    const t = (
      window as unknown as {
        __tap: { on: boolean; sr: number; chunks: Float32Array[][] };
      }
    ).__tap;
    t.on = false;
    const n = t.chunks.reduce((a, ch) => a + (ch[0]?.length ?? 0), 0);
    const out = new Float32Array(n * 2);
    let o = 0;
    for (const ch of t.chunks) {
      const [l, r] = ch;
      if (!l || !r) continue;
      out.set(l, o);
      out.set(r, n + o);
      o += l.length;
    }
    let bin = "";
    const bytes = new Uint8Array(out.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { sr: t.sr, n, b64: btoa(bin) };
  });
  await context.close();
  if (raw.n === 0)
    throw new Error(
      "sonata audio: the tap recorded nothing (no AudioContext reached its destination)",
    );
  const all = new Float32Array(Buffer.from(raw.b64, "base64").buffer.slice(0));
  const left = all.subarray(0, raw.n);
  const right = all.subarray(raw.n);
  const win = Math.round(raw.sr * 0.01);
  let onset = -1;
  for (let i = 0; i + win < raw.n && onset < 0; i += win) {
    let e = 0;
    for (let j = 0; j < win; j++)
      e += (left[i + j] ?? 0) ** 2 + (right[i + j] ?? 0) ** 2;
    if (Math.sqrt(e / (2 * win)) > 0.004) onset = i;
  }
  if (onset < 0)
    throw new Error(
      "sonata audio: the recording is silent (samples not loaded or audio muted)",
    );
  const start = Math.max(0, onset - Math.round(raw.sr * 0.03));
  const len = Math.min(raw.n - start, Math.round(raw.sr * SECONDS));
  const file = opts.out ?? "sonata-piano.wav";
  writeFileSync(
    opts.out ?? join(REC_DIR, file),
    wav(
      left.slice(start, start + len),
      right.slice(start, start + len),
      raw.sr,
    ),
  );
  const clip: AudioClip = { file, duration: len / raw.sr };
  if (opts.out === undefined)
    writeFileSync(join(REC_DIR, "sonata-piano.json"), JSON.stringify(clip));
  console.log(
    `sonata audio: ${clip.duration.toFixed(2)} s at ${raw.sr} Hz (first onset ${(onset / raw.sr).toFixed(2)} s after Play)`,
  );
  return clip;
}
