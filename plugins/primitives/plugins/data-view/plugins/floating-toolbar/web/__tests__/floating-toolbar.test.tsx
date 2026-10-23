import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { floatingToolbar } from "../internal/floating-toolbar";

afterEach(cleanup);

describe("floatingToolbar", () => {
  it("floats over the view, asking for the filled / ghost / labelled forms", () => {
    expect(floatingToolbar.overlay).toBe(true);
    expect(floatingToolbar.forms).toEqual({
      search: "filled",
      controls: "ghost",
      creators: "labelled",
    });
  });

  it("places the title and strip in a pill past the aside, the tools in another", () => {
    const Floating = floatingToolbar.component;
    const { container } = render(
      <Floating
        title={<span data-testid="title" />}
        switcher={{
          strip: <span data-testid="strip" />,
          chip: <span data-testid="chip" />,
        }}
        search={<span data-testid="search" />}
        focusSearch={() => {}}
        query=""
        controls={<span data-testid="controls" />}
        foldedControls={<span data-testid="folded" />}
        actions={<span data-testid="actions" />}
        creators={<span data-testid="creators" />}
        asideInset="240px"
      />,
    );

    expect(screen.getByTestId("strip")).toBeTruthy();
    expect(screen.queryByTestId("chip")).toBeNull();
    expect(screen.queryByTestId("folded")).toBeNull();
    for (const id of ["title", "search", "controls", "actions", "creators"]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    // The row starts past the aside's reach plus its own gutter.
    const row = container.firstElementChild as HTMLElement;
    expect(row.style.paddingLeft).toContain("240px");
    // Both pills opt back into pointer events over the click-through band;
    // the title rides the views pill (no band surface to read on).
    const cards = container.querySelectorAll(".pointer-events-auto");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.contains(screen.getByTestId("title"))).toBe(true);
    expect(cards[0]!.contains(screen.getByTestId("strip"))).toBe(true);
    expect(cards[1]!.contains(screen.getByTestId("search"))).toBe(true);
    // The create affordance follows a divider, inside the tools pill.
    expect(cards[1]!.contains(screen.getByTestId("creators"))).toBe(true);
    expect(cards[1]!.querySelector('[data-slot="separator"]')).not.toBeNull();
  });
});
