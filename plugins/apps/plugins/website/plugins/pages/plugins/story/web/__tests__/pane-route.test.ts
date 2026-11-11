import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePaneTitle } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { storyPage } from "../../core";
import { storyPane } from "../panes";

// The pane takes its title from its page declaration and its route from the
// page path (`crawlable:pages-declared`): its URL and
// route id must stay what they were before — links, history entries and
// section-reach keys all carry them.
describe("storyPane", () => {
  it("keeps its URL and route id", () => {
    expect(storyPane.link(websiteApp, {})).toBe("/about/story");
    expect(storyPane._internal.id).toBe("website-story");
    expect(storyPane._internal.appIndex).toBe(false);
  });

  it("takes its title from the page declaration", () => {
    const { result } = renderHook(() =>
      usePaneTitle(storyPane._internal, {}, {}, {}),
    );
    expect(result.current).toBe(storyPage.title);
  });
});
