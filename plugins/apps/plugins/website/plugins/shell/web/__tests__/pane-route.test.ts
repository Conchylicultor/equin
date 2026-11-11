import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePaneTitle } from "@plugins/primitives/plugins/pane/web";
import { landingPage, websiteApp } from "../../core";

import { landingPane } from "../panes";

// The pane takes its title from its page declaration and its route from the
// page path (`crawlable:pages-declared`): its URL and
// route id must stay what they were before — links, history entries and
// section-reach keys all carry them.
describe("landingPane", () => {
  it("keeps its URL and route id", () => {
    expect(landingPane.link(websiteApp, {}).replace(/\/$/, "")).toBe(
      "/website",
    );
    expect(landingPane._internal.id).toBe("website-landing");
    expect(landingPane._internal.appIndex).toBe(true);
  });

  it("takes its title from the page declaration", () => {
    const { result } = renderHook(() =>
      usePaneTitle(landingPane._internal, {}, {}, {}),
    );
    expect(result.current).toBe(landingPage.title);
  });
});
