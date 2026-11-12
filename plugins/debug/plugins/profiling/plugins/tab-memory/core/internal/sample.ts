import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * How often a page samples itself. There is no change signal for a page's
 * memory, and the climbs this exists to name last hours (2026-11-10: ~1.4 GB/h
 * for five hours), so a few minutes between samples loses nothing.
 */
export const TAB_MEMORY_SAMPLE_EVERY_MS = 5 * 60_000;

/** The first sample, once the page has booted and settled. */
export const TAB_MEMORY_FIRST_SAMPLE_MS = 30_000;

/** In-app tabs one sample lists (a page holding more is the finding itself). */
export const MAX_IN_APP_TABS = 100;

/** One open in-app tab of one tab set — mounted (keep-alive), so held in memory. */
export const InAppTabSchema = z.object({
  /** The tab set: `page`, or `embed:<id>` for an AppEmbed's. */
  set: z.string().max(200),
  appId: z.string().max(200),
  path: z.string().max(500),
  /** Its set's focused tab. */
  focused: z.boolean(),
});
export type InAppTab = z.infer<typeof InAppTabSchema>;

/**
 * One page's reading of itself. A page is one document load in one browser
 * tab (`tabId` + `pageStartedAt`): a reload starts a new heap, so a new page.
 * Sizes are MB.
 */
export const TabMemorySampleSchema = z.object({
  sampledAt: z.number().int(),
  /** The browser tab (`getTabId()`, stable across its reloads). */
  tabId: z.string().max(100),
  /** `performance.timeOrigin`: when this document started loading. */
  pageStartedAt: z.number().int(),
  /** The namespace host the page is served from (`equin.localhost:9000`). */
  host: z.string().max(200),
  /** The address bar's in-app route. */
  route: z.string().max(500),
  /** The app of the page's focused in-app tab (null on an empty surface). */
  focusedAppId: z.string().max(200).nullable(),
  /** The page was visible when sampled. */
  visible: z.boolean(),
  /**
   * `performance.memory`: Chrome only, and coarse — bucketed and refreshed
   * about every 20 minutes (measured 2026-11-12: a 160 MB allocation left it
   * unchanged). Null where the browser has none.
   */
  jsHeapUsedMb: z.number().nullable(),
  jsHeapTotalMb: z.number().nullable(),
  /** Elements in the document, exact. */
  domNodes: z.number().int().min(0),
  /** `<canvas>` elements and their backing stores (w × h × 4 bytes). */
  canvases: z.number().int().min(0),
  canvasMb: z.number().min(0),
  /** Decoded `<img>` pixels (natural w × h × 4 bytes). */
  imagesMb: z.number().min(0),
  iframes: z.number().int().min(0),
  /** `<video>` / `<audio>` elements. */
  media: z.number().int().min(0),
  inAppTabs: cappedList(InAppTabSchema, { max: MAX_IN_APP_TABS }),
});
export type TabMemorySample = z.infer<typeof TabMemorySampleSchema>;

/** A page posts each sample to its own server, which logs it (`tab-memory`). */
export const submitTabMemorySample = defineEndpoint({
  route: "POST /api/tab-memory/sample",
  // A page's own memory reading: an agent session's pages are observability
  // like a user's (main is read-only for agents otherwise).
  agentWrite: "telemetry",
  body: z.object({ sample: TabMemorySampleSchema }),
});
