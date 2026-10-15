/**
 * The transcript card draws no chevron: the whole header row is the toggle,
 * and the toggle button's accessible state (`aria-expanded`, the Expand /
 * Collapse label) is what says whether the card is open. This suite pins both
 * halves — nothing chevron-shaped renders, and the row still opens and closes
 * the body.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { CollapsibleCard } from "../components/collapsible-card";

// The shared row-action strip reads the plugin registry, which a unit render
// does not have; it is not what is under test.
vi.mock(
  "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web",
  () => ({ EventRowActions: () => null }),
);

afterEach(cleanup);

describe("CollapsibleCard", () => {
  it("renders no chevron", () => {
    const { container } = render(
      <CollapsibleCard label="Thinking">body</CollapsibleCard>,
    );
    // The only glyph a bare card could draw was the chevron.
    expect(container.querySelector("svg")).toBeNull();
  });

  it("still toggles from the row, and says so to assistive tech", async () => {
    render(<CollapsibleCard label="Thinking">the body</CollapsibleCard>);
    const toggle = screen.getByRole("button", { name: "Expand" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("the body")).toBeNull();

    fireEvent.click(toggle);
    const open = screen.getByRole("button", { name: "Collapse" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("the body")).toBeTruthy();

    fireEvent.click(open);
    // The body folds away first, then unmounts.
    expect(open.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(screen.queryByText("the body")).toBeNull());
  });
});
