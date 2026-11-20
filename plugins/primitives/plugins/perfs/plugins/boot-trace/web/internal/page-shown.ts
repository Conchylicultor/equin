import { FIRST_HIDDEN_GLOBAL, pageShown, type PageShown } from "../../core";

/** `activationStart` (Chromium, prerendering): absent from older lib.dom typings. */
function activationStartMs(): number {
  const nav = performance.getEntriesByType("navigation")[0];
  const at: unknown = nav ? Reflect.get(nav, "activationStart") : undefined;
  return typeof at === "number" && Number.isFinite(at) ? at : 0;
}

function recordedFirstHiddenMs(): number | null {
  const at: unknown = Reflect.get(window, FIRST_HIDDEN_GLOBAL);
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

function visibilityEntries(): readonly PerformanceEntry[] {
  // Only Chromium keeps them; asking another browser for an unknown type
  // answers [] (and may warn), so ask only where the type is supported.
  return PerformanceObserver.supportedEntryTypes?.includes("visibility-state")
    ? performance.getEntriesByType("visibility-state")
    : [];
}

/**
 * Whether the visitor could see this page load from its navigation's start
 * until now (`core/page-shown.ts`), read from every record the browser and
 * the page shell keep — so a reader mounted late still knows of a hide that
 * happened before it ran.
 */
export function readPageShown(): PageShown {
  return pageShown({
    prerendering: Reflect.get(document, "prerendering") === true,
    activationStartMs: activationStartMs(),
    visibilityEntries: visibilityEntries(),
    recordedFirstHiddenMs: recordedFirstHiddenMs(),
    hiddenNow: document.visibilityState !== "visible",
    nowMs: performance.now(),
  });
}
