import type { OwnerSample } from "@plugins/debug/plugins/sentinel/plugins/machine-usage/core";
import {
  MAX_PAGE_POINTS,
  MAX_PAGES,
  MAX_RENDERER_POINTS,
  MAX_RENDERERS,
  RENDERER_BUCKET_MS,
  type PageSeries,
  type RendererSeries,
  type TabMemorySample,
} from "../../core";

/** The user's Chrome's renderer processes, as the owner sampler names them. */
function isChromeRenderer(p: OwnerSample["top"][number]): boolean {
  return p.bucket === "chrome" && p.name.endsWith("(Renderer)");
}

/**
 * Every worktree's samples grouped into pages (one document load each), in
 * time order — the most recently seen `MAX_PAGES`, each keeping its newest
 * `MAX_PAGE_POINTS` points.
 */
export function pagesFrom(
  logs: readonly { worktree: string; samples: readonly TabMemorySample[] }[],
): PageSeries[] {
  const pages = new Map<
    string,
    { worktree: string; samples: TabMemorySample[] }
  >();
  for (const { worktree, samples } of logs) {
    for (const s of samples) {
      const pageId = `${worktree}:${s.tabId}:${s.pageStartedAt}`;
      const page = pages.get(pageId);
      if (page) page.samples.push(s);
      else pages.set(pageId, { worktree, samples: [s] });
    }
  }
  const out: PageSeries[] = [];
  for (const [pageId, { worktree, samples }] of pages) {
    samples.sort((a, b) => a.sampledAt - b.sampledAt);
    out.push({
      pageId,
      worktree,
      first: samples[0]!,
      latest: samples.at(-1)!,
      points: samples.slice(-MAX_PAGE_POINTS).map((s) => ({
        t: s.sampledAt,
        jsHeapUsedMb: s.jsHeapUsedMb,
        domNodes: s.domNodes,
        inAppTabs: s.inAppTabs.length,
        route: s.route,
        visible: s.visible,
      })),
    });
  }
  return out
    .sort((a, b) => b.latest.sampledAt - a.latest.sampledAt)
    .slice(0, MAX_PAGES);
}

/**
 * Each Chrome renderer the owner sampler named (by pid — lines from before it
 * recorded one are skipped), its readings folded into `RENDERER_BUCKET_MS`
 * buckets keeping the largest: the `MAX_RENDERERS` with the largest peak.
 * Only the largest processes are named per window, so a small renderer's
 * series has gaps; a climbing one does not.
 */
export function renderersFrom(
  samples: readonly OwnerSample[],
): RendererSeries[] {
  const byPid = new Map<number, Map<number, number>>();
  for (const s of samples) {
    const bucket =
      Math.floor(s.sampledAt / RENDERER_BUCKET_MS) * RENDERER_BUCKET_MS;
    for (const p of s.top) {
      if (p.pid === undefined || !isChromeRenderer(p)) continue;
      let points = byPid.get(p.pid);
      if (!points) byPid.set(p.pid, (points = new Map()));
      points.set(bucket, Math.max(points.get(bucket) ?? 0, p.memMb));
    }
  }
  const out: RendererSeries[] = [];
  for (const [pid, points] of byPid) {
    const sorted = [...points]
      .sort(([a], [b]) => a - b)
      .slice(-MAX_RENDERER_POINTS)
      .map(([t, memMb]) => ({ t, memMb }));
    out.push({
      pid,
      peakMb: Math.max(...sorted.map((p) => p.memMb)),
      points: sorted,
    });
  }
  return out.sort((a, b) => b.peakMb - a.peakMb).slice(0, MAX_RENDERERS);
}
