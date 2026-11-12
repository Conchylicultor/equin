import { z } from "zod";
import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { InAppTabSchema } from "./sample";

/** The report kind a climbing (or plainly too large) Chrome renderer files. */
export const TAB_MEMORY_CLIMB_KIND = "tab-memory-climb";

/**
 * The climb watch's bars. Calibrated on main's health-owners log, 2026-11-07 →
 * 2026-11-12: the user's largest renderer rests at 0.6–1.3 GB and swings up to
 * ~2.4 GB between collections, but its 30-minute floor stays under 2 GB. The
 * leaks climbed that floor from ~1 GB to 3.3–10.7 GB at 0.5–1.4 GB/h, and sat
 * at 3.3–4 GB for hours while the user was away.
 */
export const tabMemoryClimbConfig = defineConfig({
  name: "tab-memory-climb",
  fields: {
    enabled: boolField({
      default: true,
      label: "Enabled",
      description:
        "When off, the climb watch files no tab-memory-climb reports.",
    }),
    highFloorMb: intField({
      default: 3000,
      min: 500,
      label: "Too large (MB)",
      description:
        "File a report when a Chrome renderer's lowest footprint over the last 30 minutes is at least this many MB, climbing or not.",
    }),
    climbFloorMb: intField({
      default: 2500,
      min: 500,
      label: "Climbing from (MB)",
      description:
        "A renderer whose floor rose is reported as climbing once its lowest footprint over the last 30 minutes reaches this many MB.",
    }),
    climbRiseMb: intField({
      default: 1000,
      min: 100,
      label: "Climb of at least (MB)",
      description:
        "How far a renderer's 30-minute floor must sit above its lowest reading in the 3 hours before to count as climbing.",
    }),
  },
});

/** What grew, as far as the pages' own figures can tell. */
export const TAB_MEMORY_GROWTH = [
  /** A page's JS heap grew by a third or more of the renderer's climb. */
  "js-heap",
  /** A page's canvas backing stores + decoded images did. */
  "canvas-images",
  /** A page's DOM node count climbed (≥ 10,000 more, ≥ 1.5×). */
  "dom",
  /** Pages sampled through the window, but none of their figures explain it. */
  "native",
  /** No page sampled itself through the window (not equin, or an old build). */
  "unattributed",
] as const;
export type TabMemoryGrowth = (typeof TAB_MEMORY_GROWTH)[number];

/** Pages listed as candidates per report: the most likely first. */
export const MAX_CLIMB_PAGES = 6;
/** In-app tabs listed per candidate page (the total rides beside it). */
export const MAX_CLIMB_PAGE_TABS = 20;
/** The renderer's curve: 20-minute bins over the last 6 hours. */
export const CLIMB_CURVE_BIN_MS = 20 * 60_000;
export const CLIMB_CURVE_MS = 6 * 60 * 60_000;
export const MAX_CLIMB_CURVE_POINTS = 24;

/** One page alive in the renderer's window, with its figures across it. */
export const ClimbPageSchema = z.object({
  pageId: z.string(),
  worktree: z.string(),
  host: z.string(),
  route: z.string(),
  focusedAppId: z.string().nullable(),
  visible: z.boolean(),
  /** Still sampling at the report (its last sample within 15 minutes). */
  alive: z.boolean(),
  pageStartedAt: z.number(),
  lastSampledAt: z.number(),
  /** Its figures at its first and last sample inside the window. */
  jsHeapStartMb: z.number().nullable(),
  jsHeapNowMb: z.number().nullable(),
  domStart: z.number(),
  domNow: z.number(),
  canvasImagesStartMb: z.number(),
  canvasImagesNowMb: z.number(),
  inAppTabsTotal: z.number(),
  inAppTabs: cappedList(InAppTabSchema, { max: MAX_CLIMB_PAGE_TABS }),
});
export type ClimbPage = z.infer<typeof ClimbPageSchema>;

/** The `tab-memory-climb` report's payload: one Chrome renderer, by pid. */
export const TabMemoryClimbSchema = z.object({
  pid: z.number().int(),
  /** `climbing`: its floor rose past the bar; `high`: its floor is past the size bar. */
  trigger: z.enum(["climbing", "high"]),
  /** Lowest footprint over the last 30 minutes (immune to GC sawtooth). */
  floorNowMb: z.number(),
  peakMb: z.number(),
  /** Lowest reading in the 3 h before, its rise to now and the rate. */
  baselineMb: z.number().nullable(),
  riseMb: z.number().nullable(),
  riseMbPerHour: z.number().nullable(),
  /** The window the pages are judged over: from the baseline to now. */
  windowStart: z.number(),
  windowEnd: z.number(),
  growth: z.enum(TAB_MEMORY_GROWTH),
  curve: cappedList(
    z.object({ t: z.number(), minMb: z.number(), maxMb: z.number() }),
    { max: MAX_CLIMB_CURVE_POINTS },
  ),
  pages: cappedList(ClimbPageSchema, { max: MAX_CLIMB_PAGES }),
  thresholds: z.object({
    highFloorMb: z.number(),
    climbFloorMb: z.number(),
    climbRiseMb: z.number(),
  }),
});
export type TabMemoryClimb = z.infer<typeof TabMemoryClimbSchema>;
