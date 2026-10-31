// What every recorded segment of the film shares: the capture viewport, where
// the recordings live, opening a route in real time before a recording starts,
// and reading a recording back.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { pathUrl } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { AssetManifest } from "@plugins/media/plugins/film/e2e";

export const W = 1280;
export const H = 720;
/** Recorded at 2x: a 2560×1440 frame stays sharp under the 1.45x push-ins of a 1080p film. */
export const DPR = 2;

/** Every recording (frames + input log) and the stills, one dir: the film's asset dir. */
export const REC_DIR = "/tmp/equin-film/session";

export function newManifest(): AssetManifest {
  return {
    dpr: DPR,
    width: W,
    height: H,
    stills: {},
    rects: {},
    sequences: {},
    strips: {},
    stripRects: {},
    audio: {},
  };
}

/** Open an app route and let it boot in real time (fetches, fonts, first paint). */
export async function open(
  p: Page,
  path: string,
  /** `untitled`: a surface whose document title names no app (the empty desktop). */
  opts: { settleMs?: number; untitled?: boolean } = {},
): Promise<void> {
  await p.goto(pathUrl(path), { waitUntil: "load" });
  await p.waitForFunction(
    (untitled) =>
      (untitled || document.title.includes(" — ")) &&
      document.body.innerText.trim().length > 20,
    opts.untitled ?? false,
    { timeout: 60_000 },
  );
  await p.waitForTimeout(opts.settleMs ?? 2500);
}

/** Wait (real time, before a recording) until `loc` is visible. */
export async function visible(loc: Locator, timeout = 30_000): Promise<void> {
  await loc.first().waitFor({ state: "visible", timeout });
}

/**
 * What a segment read off the page while recording that its frames do not
 * carry as data (e.g. the player's clock): `<name>.facts.json`.
 */
export interface SegmentFacts {
  /** integrated: Sonata's playhead (s) when the recording paused it. */
  playheadAtEnd?: number;
  /** integrated: Sonata's playhead (s) where the recording paused it — where `sonata` resumes. */
  pausedAt?: number;
  /** integrated: the song's route as it was left (its URL names the bar) — where `sonata` opens. */
  songPath?: string;
}

export function writeSegmentFacts(name: string, facts: SegmentFacts): void {
  writeFileSync(join(REC_DIR, `${name}.facts.json`), JSON.stringify(facts));
}

export function readSegmentFacts(name: string): SegmentFacts {
  const file = join(REC_DIR, `${name}.facts.json`);
  if (!existsSync(file))
    throw new Error(`promo-film: no facts for "${name}" — re-record it`);
  return JSON.parse(readFileSync(file, "utf8")) as SegmentFacts;
}
