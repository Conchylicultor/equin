import { fetchEndpointOver } from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import { currentRoutePath } from "@plugins/primitives/plugins/pane/web";
import {
  EVENT_NAME_PATTERN,
  collectEndpoint,
  type CollectBody,
} from "../../core";
import { landingSource } from "./landing";
import { createTracker, type Tracker } from "./tracker";

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

/**
 * The page load's one tracker, created on first use. Module scope is the dedup
 * boundary: a remounted `<AnalyticsTracker />` (or two of them) reads the same
 * state, so a path is never counted twice. The landing source is read here, at
 * creation, which is the first moment anything is tracked.
 */
export function getTracker(): Tracker {
  if (instance) return instance;
  const host = window.location.host;
  const tracker = createTracker({
    host,
    landing: landingSource({
      referrer: document.referrer,
      search: window.location.search,
      siteHost: host,
    }),
    send,
    now: () => performance.now(),
    isVisible: () => document.visibilityState === "visible",
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") tracker.hidden();
    else tracker.visible();
  });
  window.addEventListener("pagehide", () => tracker.hidden());
  window.addEventListener("pageshow", () => tracker.visible());
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
