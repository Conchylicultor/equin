import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Placement } from "@plugins/apps-core/core";
import {
  PAGE_TAB_SET_ID,
  registerTabSet,
  useFocusedTabSet,
  type TabSetHandle,
} from "./tab-sets";

function Probe() {
  const { handle, mode } = useFocusedTabSet();
  return <i>{`${handle?.id ?? "none"},${mode ?? "none"}`}</i>;
}

// A static render to HTML (react-dom/server, no DOM) reads the registry as it
// stands: the tab set mounted now and its mode, or none before any mounted.
describe("useFocusedTabSet under a server render", () => {
  it("answers no set before any mounted", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>none,none</i>");
  });

  it("answers the page's set and its mode once registered", () => {
    const mode: Placement = "solo";
    const handle: TabSetHandle = {
      id: PAGE_TAB_SET_ID,
      contained: false,
      mode: () => mode,
      hasTab: () => false,
      focusedTabId: () => undefined,
      openTabs: () => [],
      setMode: () => {},
      exitToPreviousMode: () => {},
      browserTabUrl: (path) => path,
    };
    const dispose = registerTabSet(handle);
    try {
      expect(renderToStaticMarkup(<Probe />)).toBe("<i>page,solo</i>");
    } finally {
      dispose();
    }
  });
});
