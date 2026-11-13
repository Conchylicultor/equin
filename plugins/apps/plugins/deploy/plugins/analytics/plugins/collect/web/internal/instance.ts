import { fetchEndpointOver } from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import { currentRoutePath } from "@plugins/primitives/plugins/pane/web";
import { ROUTE_CONTENT_COMMIT_ID } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";
import { getBootTrace } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import {
  EVENT_NAME_PATTERN,
  collectEndpoint,
  stripQuery,
  type CollectBody,
} from "../../core";
import { consentKeyOf, consentStore } from "./consent";
import { landingSource } from "./landing";
import {
  applyOwnerFragment,
  isOwnerMarked,
  ownerMarkStore,
} from "./owner-mark";
import { createPageSectionRegistry } from "./page-sections";
import { createTracker, type LoadMilestones, type Tracker } from "./tracker";

// Page-wide telemetry: page-view analytics always reach the page's own server (D3).
const fetchEndpoint = fetchEndpointOver(pageTransport);

/**
 * Posts one collect body. `keepalive` lets the engagement beacon sent on
 * `pagehide` outlive the page.
 *
 * Passive telemetry, the same contract as the slow-op beacon: `report: false`
 * so a failed beacon never toasts or files a report about itself, and the
 * rejection is NOT caught — it surfaces as an unhandled rejection in the
 * console, which is loud without breaking anything the visitor sees.
 */
function send(body: CollectBody) {
  return fetchEndpoint(
    collectEndpoint,
    {},
    { body, keepalive: true, report: false },
  );
}

let instance: Tracker | null = null;

/** The page load's sections per path; module scope, like the tracker. */
const pageSections = createPageSectionRegistry();

/**
 * Lists `el` as section `section` of the page the address shows now, for the
 * page's full section list its beacons carry. Returns the unmount.
 */
export function registerPageSection(el: Element, section: string): () => void {
  return pageSections.register(stripQuery(currentRoutePath()), el, section);
}

/** Input that says someone is at the page (passive listeners, capture phase so element scrolls count). */
const INPUT_EVENTS = [
  "pointermove",
  "pointerdown",
  "keydown",
  "wheel",
  "scroll",
  "touchstart",
] as const;
/**
 * Media starting or stopping. They do not bubble, hence capture. A pause or
 * end restarts the idle clock the playback was holding off.
 */
const MEDIA_EVENTS = ["play", "pause", "ended"] as const;

/**
 * Audible media playing. A muted (decorative, autoplaying) loop never pauses,
 * so counting it would keep a tab left open on it from ever reading as idle.
 */
function isMediaPlaying(): boolean {
  for (const media of document.querySelectorAll("video, audio"))
    if (
      media instanceof HTMLMediaElement &&
      !media.paused &&
      !media.ended &&
      !media.muted &&
      media.volume > 0
    )
      return true;
  return false;
}

/**
 * The page load's milestones, from the framework's boot trace (one clock:
 * `performance.now()`, navigation start = 0). Ready is the later of the first
 * contentful paint and the commit showing the active app's content — not
 * `bootWindowEnd`'s first commit, which on a site is its loading screen.
 * Paint timing may be unsupported: its milestones then stay null.
 */
function loadMilestones(): LoadMilestones {
  const trace = getBootTrace();
  const fcp = trace.paint.firstContentfulPaintMs;
  const content =
    trace.spans.find((s) => s.id === ROUTE_CONTENT_COMMIT_ID)?.startMs ?? null;
  return {
    firstByteAt: trace.navigation?.responseStartMs ?? null,
    firstContentfulPaintAt: fcp,
    readyAt: content === null ? null : Math.max(content, fcp ?? 0),
  };
}

/** Applies a mark link's fragment to this browser (`owner-mark.ts`). */
function readOwnerFragment(): void {
  applyOwnerFragment(window.location.hash, ownerMarkStore);
}

/**
 * The page load's one tracker, created on first use. Module scope is the dedup
 * boundary: a remounted `<AnalyticsTracker />` (or two of them) reads the same
 * state, so a path is never counted twice. The landing source is read here, at
 * creation, which is the first moment anything is tracked.
 */
export function getTracker(): Tracker {
  if (instance) return instance;
  // A mark link (`#equin-me`) is read before the first pageview, so that
  // pageview is already the owner's.
  readOwnerFragment();
  window.addEventListener("hashchange", readOwnerFragment);
  const host = window.location.host;
  const tracker = createTracker({
    host,
    landing: landingSource({
      referrer: document.referrer,
      search: window.location.search,
      siteHost: host,
    }),
    isOwner: () => isOwnerMarked(ownerMarkStore),
    consentKey: () => consentKeyOf(consentStore),
    send,
    now: () => performance.now(),
    isVisible: () => document.visibilityState === "visible",
    setDeadline: (delayMs, fire) => {
      const timer = setTimeout(fire, delayMs);
      return () => clearTimeout(timer);
    },
    isMediaPlaying,
    loadMilestones,
    pageSections: (path) => pageSections.sectionsOf(path),
  });
  const activity = () => tracker.activity();
  for (const type of [...INPUT_EVENTS, ...MEDIA_EVENTS])
    document.addEventListener(type, activity, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") tracker.hidden();
    else tracker.visible();
  });
  window.addEventListener("pagehide", () => tracker.hidden());
  window.addEventListener("pageshow", () => {
    // A bfcache restore can land in a background tab: its visibilitychange shows it later.
    if (document.visibilityState === "visible") tracker.visible();
  });
  instance = tracker;
  return tracker;
}

/**
 * Records a custom event on the current page. `name` must match
 * `EVENT_NAME_PATTERN` (lowercase letters, digits, underscores); props are at
 * most `MAX_EVENT_PROPS` short strings.
 */
export function track(name: string, props?: Record<string, string>): void {
  // A bad name is a programming error the server would only answer with a 400
  // no one reads: refuse it at the call site instead.
  if (!EVENT_NAME_PATTERN.test(name))
    throw new Error(
      `[analytics] event name ${JSON.stringify(name)} must match ${String(EVENT_NAME_PATTERN)}`,
    );
  getTracker().track(name, props, currentRoutePath());
}
