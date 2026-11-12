import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { TabMemorySampleSchema } from "./sample";

/** How far back the pane reads: longer than the climbs it exists to name. */
export const TAB_MEMORY_WINDOW_MS = 12 * 60 * 60_000;

/** Pages listed: the ones seen most recently. */
export const MAX_PAGES = 60;
/** Points per page: 12 h at one sample per 5 min is 144. */
export const MAX_PAGE_POINTS = 200;
/** Renderers listed: the ones with the largest peak. */
export const MAX_RENDERERS = 40;
/** A renderer's points: its 30 s readings folded into 2-minute buckets (max). */
export const RENDERER_BUCKET_MS = 2 * 60_000;
export const MAX_RENDERER_POINTS = 400;

export const PagePointSchema = z.object({
  t: z.number(),
  jsHeapUsedMb: z.number().nullable(),
  domNodes: z.number(),
  /** Canvas backing stores + decoded images, MB. */
  canvasImagesMb: z.number(),
  inAppTabs: z.number(),
  route: z.string(),
  visible: z.boolean(),
});
export type PagePoint = z.infer<typeof PagePointSchema>;

export const PageSeriesSchema = z.object({
  /** `<worktree>:<tabId>:<pageStartedAt>`. */
  pageId: z.string(),
  /** The worktree whose log it came from (the server the page talks to). */
  worktree: z.string(),
  first: TabMemorySampleSchema,
  latest: TabMemorySampleSchema,
  points: cappedList(PagePointSchema, { max: MAX_PAGE_POINTS }),
});
export type PageSeries = z.infer<typeof PageSeriesSchema>;

/** One Chrome renderer process of the user's Chrome, from main's health-owners log. */
export const RendererSeriesSchema = z.object({
  pid: z.number(),
  peakMb: z.number(),
  points: cappedList(z.object({ t: z.number(), memMb: z.number() }), {
    max: MAX_RENDERER_POINTS,
  }),
});
export type RendererSeries = z.infer<typeof RendererSeriesSchema>;

export const TabMemoryDataSchema = z.object({
  windowMs: z.number(),
  readAtMs: z.number(),
  pages: cappedList(PageSeriesSchema, { max: MAX_PAGES }),
  renderers: cappedList(RendererSeriesSchema, { max: MAX_RENDERERS }),
});
export type TabMemoryData = z.infer<typeof TabMemoryDataSchema>;

/**
 * Every page that sampled itself in the last 12 h (from every worktree's
 * `tab-memory` log) beside each Chrome renderer's footprint, so a climbing
 * renderer can be matched to the page climbing with it.
 */
export const tabMemorySeries = liveValue("tab-memory.series", {
  schema: TabMemoryDataSchema,
});
