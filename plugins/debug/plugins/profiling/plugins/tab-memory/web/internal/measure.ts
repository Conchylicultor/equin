import { peekTabSets } from "@plugins/apps-core/plugins/tabs/web";
import { currentRoutePath } from "@plugins/primitives/plugins/pane/web";
import { getTabId } from "@plugins/primitives/plugins/scope/plugins/tab-id/web";
import {
  MAX_IN_APP_TABS,
  type InAppTab,
  type TabMemorySample,
} from "../../core";

const MB = 1_048_576;

/** Chrome's non-standard `performance.memory`. */
interface ChromeMemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
}

function chromeMemory(): ChromeMemoryInfo | null {
  const info = (performance as Performance & { memory?: ChromeMemoryInfo })
    .memory;
  return info ?? null;
}

const round = (mb: number): number => Math.round(mb * 10) / 10;

/** Canvas backing stores, decoded images and the other element counts. */
export function measureDocument(doc: Document): {
  domNodes: number;
  canvases: number;
  canvasMb: number;
  imagesMb: number;
  iframes: number;
  media: number;
} {
  let canvasBytes = 0;
  const canvases = doc.getElementsByTagName("canvas");
  for (const c of canvases) canvasBytes += c.width * c.height * 4;
  let imageBytes = 0;
  for (const img of doc.getElementsByTagName("img"))
    if (img.complete) imageBytes += img.naturalWidth * img.naturalHeight * 4;
  return {
    domNodes: doc.getElementsByTagName("*").length,
    canvases: canvases.length,
    canvasMb: round(canvasBytes / MB),
    imagesMb: round(imageBytes / MB),
    iframes: doc.getElementsByTagName("iframe").length,
    media:
      doc.getElementsByTagName("video").length +
      doc.getElementsByTagName("audio").length,
  };
}

/** Every open in-app tab of every mounted tab set, the page's first. */
function inAppTabs(): { tabs: InAppTab[]; focusedAppId: string | null } {
  const sets = [...peekTabSets()].sort(
    (a, b) => Number(a.contained) - Number(b.contained),
  );
  let focusedAppId: string | null = null;
  const tabs: InAppTab[] = [];
  for (const set of sets) {
    for (const t of set.openTabs()) {
      if (!set.contained && t.focused) focusedAppId = t.appId;
      tabs.push({
        set: set.id,
        appId: t.appId,
        path: t.path.slice(0, 500),
        focused: t.focused,
      });
    }
  }
  return { tabs: tabs.slice(0, MAX_IN_APP_TABS), focusedAppId };
}

/** This page's reading of itself, now. */
export function takeSample(): TabMemorySample {
  const memory = chromeMemory();
  const { tabs, focusedAppId } = inAppTabs();
  return {
    sampledAt: Date.now(),
    tabId: getTabId(),
    pageStartedAt: Math.round(performance.timeOrigin),
    host: location.host.slice(0, 200),
    route: currentRoutePath().slice(0, 500),
    focusedAppId,
    visible: document.visibilityState === "visible",
    jsHeapUsedMb: memory === null ? null : round(memory.usedJSHeapSize / MB),
    jsHeapTotalMb: memory === null ? null : round(memory.totalJSHeapSize / MB),
    ...measureDocument(document),
    inAppTabs: tabs,
  };
}
