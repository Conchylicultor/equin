import { describe, expect, it, vi } from "vitest";
import { activationProps, linkProps } from "../internal/link-gesture";

// A live page (the default render mode): the destination stays a click-time
// thunk — never computed while rendering, never written into the markup.
describe("linkProps on a live page", () => {
  it("writes no data-link and does not call href()", () => {
    const href = vi.fn(() => "/agents/c/42");
    const target = { open: vi.fn(), href };
    expect(linkProps(target)).not.toHaveProperty("data-link");
    expect(activationProps(target, { isolate: true })).not.toHaveProperty(
      "data-link",
    );
    expect(href).not.toHaveBeenCalled();
  });
});
