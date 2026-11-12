// What every recorded segment of the film shares: the capture viewport, where
// the recordings live, opening a route in real time before a recording starts,
// and reading a recording back.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { pathUrl } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { AssetManifest } from "@plugins/media/plugins/film/e2e";
import {
  FILM_CLOCK_FILE,
  FilmClockSchema,
} from "@plugins/apps/plugins/website/plugins/promo-film/plugins/seed/core";
import { promoFilmWorkspaceDir } from "@plugins/apps/plugins/website/plugins/promo-film/plugins/seed/data-dirs";

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

/**
 * The film's "now" (epoch ms) — a weekday afternoon the last seed chose and
 * stamped its story from (seed core's film-clock). Every recording's pages
 * are pinned to it, so every segment shows the same day and hour.
 */
export function filmDate(): number {
  const file = promoFilmWorkspaceDir.file(FILM_CLOCK_FILE);
  if (!existsSync(file))
    throw new Error(
      `promo-film: no film clock at ${file} — run ./equin promo-film seed first`,
    );
  return FilmClockSchema.parse(JSON.parse(readFileSync(file, "utf8"))).now;
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
 * carry as data: `<name>.facts.json`.
 */
export interface SegmentFacts {
  /** The route it ends on (path, matrix params, query): where the next segment opens. */
  endPath: string;
}

/** Record where segment `name` ends, for the segment that continues it. */
export function endHere(name: string, page: Page): void {
  const u = new URL(page.url());
  const facts: SegmentFacts = { endPath: `${u.pathname}${u.search}${u.hash}` };
  writeFileSync(join(REC_DIR, `${name}.facts.json`), JSON.stringify(facts));
}

/**
 * Where the segment after `name` starts, so the join is continuous: the route
 * `name` ended on and its pointer's last position (its recording's own log).
 */
export function continueFrom(name: string): {
  path: string;
  cursor: { x: number; y: number };
} {
  const facts = join(REC_DIR, `${name}.facts.json`);
  const log = join(REC_DIR, `${name}.json`);
  if (!existsSync(facts) || !existsSync(log))
    throw new Error(
      `promo-film: "${name}" is not recorded — record it first (it ends where this segment starts)`,
    );
  const { endPath } = JSON.parse(readFileSync(facts, "utf8")) as SegmentFacts;
  const seq = JSON.parse(readFileSync(log, "utf8")) as {
    input: { cursor: Array<[number, number, number]> };
  };
  const last = seq.input.cursor[seq.input.cursor.length - 1];
  if (!last) throw new Error(`promo-film: "${name}" logged no pointer`);
  return { path: endPath, cursor: { x: last[1], y: last[2] } };
}
