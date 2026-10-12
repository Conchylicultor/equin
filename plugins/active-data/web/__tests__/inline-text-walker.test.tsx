import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useMemo, type ReactNode } from "react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  InlineText,
  InlineTextWalkerSlot,
  InlineTextWalkerContext,
  useInlineTextWalker,
} from "@plugins/primitives/plugins/inline-text/web";
import { linkifyChildren } from "@plugins/primitives/plugins/file-links/web";
import {
  InlineChip,
  inlineChip,
} from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/web";
import { ActiveDataInlineWalker } from "../internal/inline-walker";

// End-to-end pin for the order-dependent footgun this primitive eliminates: a
// raw string carrying BOTH an inline-chip pattern AND a file path must
// render BOTH a chip and a file-link button. <InlineText> always seeds with the
// string and runs active-data (order 0) before file-links (order 10) from the
// registry — the composition the old hand-wiring silently got backwards.

function Chip({ content }: { content: string }) {
  return <button type="button">{content.replace("chip-", "Chip ")}</button>;
}

// Fixture file-links walker: the real `linkifyChildren`, but with a stub
// fileTarget so the test needs no conversation/pane context (the real
// FileLinksInlineWalker resolves its file targets from those, and is exercised
// in the app). Order 10 — after active-data.
function FileLinksTestWalker({ children }: { children: ReactNode }) {
  const value = useInlineTextWalker(
    useMemo(
      () => ({
        transform: (c: ReactNode) => linkifyChildren(c, () => () => {}),
      }),
      [],
    ),
  );
  return (
    <InlineTextWalkerContext.Provider value={value}>
      {children}
    </InlineTextWalkerContext.Provider>
  );
}

const plugin = {
  id: "inline-text-active-data-test",
  description: "active-data + file-links inline-text composition fixture",
  contributions: [
    InlineChip.Tag(
      inlineChip({
        id: "inline-text-walker-test-chip",
        pattern: /chip-\w+/g,
        surfaces: ["transcript"],
        modelText: "self-describing",
        component: Chip,
      }),
    ),
    InlineTextWalkerSlot({
      id: "active-data",
      order: 0,
      Component: ActiveDataInlineWalker,
    }),
    InlineTextWalkerSlot({
      id: "file-links",
      order: 10,
      Component: FileLinksTestWalker,
    }),
  ],
} as unknown as LoadedPlugin;

afterEach(cleanup);

describe("InlineText composes the active-data + file-links walkers", () => {
  it("renders an active-data chip AND a file-link button from one raw string", () => {
    const { container } = render(
      <PluginProvider plugins={[plugin]}>
        <InlineText text="See chip-foo and dir/file.md please" />
      </PluginProvider>,
    );
    // active-data chip rendered (raw pattern gone, chip label present).
    expect(container.textContent).toContain("Chip foo");
    expect(container.textContent).not.toContain("chip-foo");
    // file path survived the composition and linkified into a button.
    expect(container.textContent).toContain("dir/file.md");
    // both the chip and the file link render as buttons.
    expect(container.querySelectorAll("button").length).toBeGreaterThanOrEqual(
      2,
    );
  });
});
