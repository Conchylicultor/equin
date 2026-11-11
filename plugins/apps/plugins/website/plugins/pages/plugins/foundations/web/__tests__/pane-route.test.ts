import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePaneTitle } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { foundationsPage } from "../../core";
import { foundationsPane } from "../panes";

// The pane takes its title from its page declaration and its route from the
// page path (`crawlable:pages-declared`): its URL and
// route id must stay what they were before — links, history entries and
// section-reach keys all carry them.
describe("foundationsPane", () => {
  it("keeps its URL and route id", () => {
    expect(foundationsPane.link(websiteApp, {})).toBe("/about/foundations");
    expect(foundationsPane._internal.id).toBe("website-foundations");
    expect(foundationsPane._internal.appIndex).toBe(false);
  });

  it("takes its title from the page declaration", () => {
    const { result } = renderHook(() =>
      usePaneTitle(foundationsPane._internal, {}, {}, {}),
    );
    expect(result.current).toBe(foundationsPage.title);
  });
});
