import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePaneTitle } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { privacyPage } from "../../core";
import { privacyPane } from "../panes";

// The pane's URL is what the consent prompt and the footer link to, and what
// the page's declaration (`crawlable:pages-declared`) names.
describe("privacyPane", () => {
  it("lives at /about/privacy", () => {
    expect(privacyPane.link(websiteApp, {})).toBe(privacyPage.path);
    expect(privacyPane._internal.id).toBe("website-privacy");
    expect(privacyPane._internal.appIndex).toBe(false);
  });

  it("takes its title from the page declaration", () => {
    const { result } = renderHook(() =>
      usePaneTitle(privacyPane._internal, {}, {}, {}),
    );
    expect(result.current).toBe(privacyPage.title);
  });
});
