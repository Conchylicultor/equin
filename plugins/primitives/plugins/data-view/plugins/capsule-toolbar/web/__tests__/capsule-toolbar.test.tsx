import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { capsuleToolbar } from "../internal/capsule-toolbar";

afterEach(cleanup);

describe("capsuleToolbar", () => {
  it("asks for the bare / round forms", () => {
    expect(capsuleToolbar.forms).toEqual({
      search: "bare",
      controls: "round",
      creators: "round",
    });
  });

  it("places the chip switcher, never the strip, and both control forms", () => {
    const Capsule = capsuleToolbar.component;
    const { container } = render(
      <Capsule
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
        asideInset="0px"
      />,
    );

    expect(screen.getByTestId("chip")).toBeTruthy();
    expect(screen.queryByTestId("strip")).toBeNull();
    // The page states its own heading; the capsule draws no title.
    expect(screen.queryByTestId("title")).toBeNull();
    // Both control forms are mounted; a container query picks which shows.
    expect(screen.getByTestId("controls")).toBeTruthy();
    expect(screen.getByTestId("folded")).toBeTruthy();
    for (const id of ["search", "actions", "creators"]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    // The divider is a vertical rule inside a fixed-height box the line
    // centres — never a fixed-height rule that is itself the flex item.
    const rule = container.querySelector('[data-slot="separator"]')!;
    expect(rule.className).not.toContain("h-5");
    expect(rule.parentElement!.className).toContain("h-5");
  });
});
