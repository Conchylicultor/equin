import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SectionHeaderRow } from "../internal/section-header-row";

afterEach(cleanup);

/** The chevron is the one `<svg>` the header draws itself. */
function chevronOf(el: HTMLElement): SVGElement {
  const svg = el.querySelector("svg");
  if (!svg) throw new Error("no chevron");
  return svg;
}

describe("SectionHeaderRow — disclosure", () => {
  it("leads with the chevron by default, always visible", () => {
    render(
      <SectionHeaderRow open onClick={() => {}}>
        Queue
      </SectionHeaderRow>,
    );
    const button = screen.getByRole("button", { name: "Queue" });
    const chevron = chevronOf(button);
    // Before the label: the first child of the control.
    expect(button.firstElementChild).toBe(chevron);
    expect(chevron.getAttribute("class")).not.toContain("opacity-0");
  });

  it("trailing: puts the chevron after the label, hidden at rest", () => {
    const onClick = vi.fn();
    render(
      <SectionHeaderRow open={false} onClick={onClick} disclosure="trailing">
        <span>Queue</span>
        <span>6</span>
      </SectionHeaderRow>,
    );
    const button = screen.getByRole("button", { name: "Queue6" });
    const chevron = chevronOf(button);
    // After the whole label run.
    expect(button.lastElementChild).toBe(chevron);
    expect(chevron.getAttribute("class")).toContain("opacity-0");
    expect(chevron.getAttribute("class")).toContain("pointer-events-none");
    // The disclosure semantics and the click target are unchanged.
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("trailing: reveals the chevron while the row is hovered", () => {
    render(
      <SectionHeaderRow open onClick={() => {}} disclosure="trailing">
        Queue
      </SectionHeaderRow>,
    );
    const button = screen.getByRole("button", { name: "Queue" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerEnter(button);
    expect(chevronOf(button).getAttribute("class")).toContain("opacity-100");
    fireEvent.pointerLeave(button);
    expect(chevronOf(button).getAttribute("class")).toContain("opacity-0");
  });

  it("trailing: still calls a caller's own pointer handler", () => {
    const onPointerEnter = vi.fn();
    render(
      <SectionHeaderRow
        open
        onClick={() => {}}
        disclosure="trailing"
        onPointerEnter={onPointerEnter}
      >
        Queue
      </SectionHeaderRow>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Queue" }));
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
  });
});

describe("SectionHeaderRow — disclosure none", () => {
  it("draws no chevron and reserves no box, but stays the disclosure control", () => {
    const onClick = vi.fn();
    render(
      <SectionHeaderRow open={false} onClick={onClick} disclosure="none">
        Tracks
      </SectionHeaderRow>,
    );
    const button = screen.getByRole("button", { name: "Tracks" });
    expect(button.querySelector("svg")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("mutes the label while collapsed, full strength while open", () => {
    const { rerender } = render(
      <SectionHeaderRow
        open={false}
        onClick={() => {}}
        disclosure="none"
        variant="title"
      >
        Tracks
      </SectionHeaderRow>,
    );
    const button = screen.getByRole("button", { name: "Tracks" });
    expect(button.className).toContain("text-muted-foreground");
    rerender(
      <SectionHeaderRow
        open
        onClick={() => {}}
        disclosure="none"
        variant="title"
      >
        Tracks
      </SectionHeaderRow>,
    );
    expect(
      screen.getByRole("button", { name: "Tracks" }).className,
    ).not.toContain("text-muted-foreground");
  });

  it("keeps header actions clickable without toggling", () => {
    const onClick = vi.fn();
    const onAction = vi.fn();
    render(
      <SectionHeaderRow
        open={false}
        onClick={onClick}
        disclosure="none"
        actions={
          <button type="button" onClick={onAction}>
            Solo
          </button>
        }
      >
        Tracks
      </SectionHeaderRow>,
    );
    const toggle = screen.getByRole("button", { name: "Tracks" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Solo" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a static header in this mode reserves no chevron box either", () => {
    const { container } = render(
      <SectionHeaderRow collapsible={false} disclosure="none">
        Key
      </SectionHeaderRow>,
    );
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("SectionHeaderRow — lead keeps the card behaviour", () => {
  it("does not mute a collapsed title", () => {
    render(
      <SectionHeaderRow open={false} onClick={() => {}} variant="title">
        Tracks
      </SectionHeaderRow>,
    );
    const button = screen.getByRole("button", { name: "Tracks" });
    expect(button.className).not.toContain("text-muted-foreground");
    expect(button.querySelector("svg")).not.toBeNull();
  });
});

describe("SectionHeaderRow — end disclosure with a rule", () => {
  it("puts a faint, always-visible chevron at the far end that brightens on hover", () => {
    render(
      <SectionHeaderRow open onClick={() => {}} disclosure="end">
        Queue
      </SectionHeaderRow>,
    );
    const button = screen.getByRole("button", { name: "Queue" });
    // Outside the control (the trailing cluster), never hidden at rest.
    expect(button.querySelector("svg")).toBeNull();
    const box = button.parentElement!;
    const chevron = box.querySelector("svg")!;
    const cls = chevron.getAttribute("class")!;
    expect(cls).toContain("text-faint-foreground");
    expect(cls).not.toContain("opacity-0");
    // Its own named group, so only this header's hover lights it.
    expect(box.className).toContain("group/section-header");
    expect(cls).toContain("group-hover/section-header:text-foreground");
  });

  it("rule: draws a decorative hairline after the label run, inside the control", () => {
    const onClick = vi.fn();
    render(
      <SectionHeaderRow open onClick={onClick} disclosure="end" rule>
        <span>Queue</span>
        <span>6</span>
      </SectionHeaderRow>,
    );
    const button = screen.getByRole("button", { name: "Queue6" });
    const rule = button.querySelector('[data-slot="separator"]')!;
    expect(rule).not.toBeNull();
    // Right after the label run, so it takes the slack; out of the a11y tree;
    // phrasing content only inside the button.
    const cell = rule.parentElement!;
    expect(screen.getByText("6").nextElementSibling).toBe(cell);
    expect(cell.getAttribute("aria-hidden")).toBe("true");
    expect(cell.tagName.toLowerCase()).toBe("span");
    expect(rule.tagName.toLowerCase()).toBe("span");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("draws no rule by default", () => {
    render(
      <SectionHeaderRow open onClick={() => {}} disclosure="end">
        Queue
      </SectionHeaderRow>,
    );
    expect(document.querySelector('[data-slot="separator"]')).toBeNull();
  });
});
