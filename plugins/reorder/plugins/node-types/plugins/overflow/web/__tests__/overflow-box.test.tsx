import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useEffect, type ReactElement } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { OverflowBox } from "../components/overflow-box";
import { symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");
const pinIcon = symbol("push-pin");

// The bucket's members are AUTHORED in config, but each one decides per row
// whether it applies (an item action returns null on a row it has nothing to do
// with). So "has members" and "will render something" are different questions,
// and only the second may paint a `⋯`: a trigger opening an empty panel is a
// dead affordance. These assert the second question is the one being asked —
// and that asking it now costs ONE mount per member, not two.

afterEach(cleanup);

/** An action that does not apply to this row — the shape every item action takes. */
function NotApplicable(): null {
  return null;
}

/** Mounts per member, so "one instance, ever" is a countable claim. */
const mounts: Record<string, number> = {};

function Applicable(): ReactElement {
  useEffect(() => {
    mounts["close"] = (mounts["close"] ?? 0) + 1;
  }, []);
  return <IconButton icon={closeIcon} label="Close conversation" />;
}

/** A second applicable action, so a bucket holds more than one present member. */
function Pin(): ReactElement {
  return <IconButton icon={pinIcon} label="Pin conversation" />;
}

/**
 * A member that is not a plain action at all. It declares no ladder, so the bar
 * may only leave it alone or relocate it AS ITSELF — the case the mechanism this
 * replaces could not represent, because it turned every member into a menu row.
 */
function Slider(): ReactElement {
  return <div role="slider" aria-label="Volume" aria-valuenow={3} />;
}

/** The `⋯` host. It exists always; it is `hidden` while nothing is behind it. */
function triggerHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-adaptive-bar-trigger]");
}

/** Is a `⋯` actually painted for this row? */
function triggerPainted(): boolean {
  const host = triggerHost();
  return host !== null && !host.hidden;
}

/** The panel each relocated member lives in — always mounted, closed in CSS. */
function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[role='dialog']");
}

function isInPanel(el: Element | null): boolean {
  return el !== null && el.closest("[role='dialog']") !== null;
}

describe("OverflowBox", () => {
  it("paints no ⋯ when every member renders nothing", () => {
    render(
      <OverflowBox payload={{}} editMode={false}>
        <NotApplicable />
        <NotApplicable />
      </OverflowBox>,
    );

    // Each member was mounted once into its own container and drew nothing, so
    // the bar knows the bucket came to nothing on this row — no second render of
    // anything was needed to find that out.
    expect(triggerPainted()).toBe(false);
  });

  it("paints the ⋯ when two or more members render", () => {
    render(
      <OverflowBox payload={{}} editMode={false}>
        <NotApplicable />
        <Applicable />
        <Pin />
      </OverflowBox>,
    );

    expect(triggerPainted()).toBe(true);
    expect(
      triggerHost()?.querySelector("button")?.getAttribute("aria-label"),
    ).toBe("More");
  });

  it("mounts each member exactly once — no probe pass, no second copy", () => {
    delete mounts["close"];
    render(
      <OverflowBox payload={{}} editMode={false}>
        <Applicable />
      </OverflowBox>,
    );

    // The old box rendered the members TWICE (a probe pass that drew nothing, to
    // be counted, plus the real one), and its own comment admitted a member
    // existed twice while the menu was open. One container, one instance.
    expect(mounts["close"]).toBe(1);
    expect(document.querySelectorAll("[data-adaptive-bar-item]")).toHaveLength(
      1,
    );
  });

  it("keeps a lone rendered member inline, with no ⋯", () => {
    render(
      <OverflowBox payload={{}} editMode={false}>
        <NotApplicable />
        <Applicable />
      </OverflowBox>,
    );

    // Two authored members, one of which applies to this row: a menu holding
    // one action costs the same click and the same room as the action, so the
    // action is drawn where the ⋯ would have been — as its icon, not a row.
    expect(triggerPainted()).toBe(false);
    const button = document.querySelector<HTMLElement>(
      "button[aria-label='Close conversation']",
    );
    expect(button).not.toBeNull();
    expect(isInPanel(button)).toBe(false);
  });

  it("sees through the slot's display:contents wrappers", () => {
    // Through `.Render` every member arrives inside reorder's and slot-render's
    // wrappers whether or not it rendered anything. An inline style rather than
    // a class because jsdom applies no stylesheet; this way `getComputedStyle`
    // reports `contents` for real, as it does in the app.
    const wrap = (child: ReactElement) => (
      <span style={{ display: "contents" }}>
        <div style={{ display: "contents" }}>{child}</div>
      </span>
    );
    render(
      <OverflowBox payload={{}} editMode={false}>
        {wrap(<NotApplicable />)}
        {wrap(<NotApplicable />)}
        {wrap(<Applicable />)}
      </OverflowBox>,
    );

    // Counting child elements would see the wrappers, call all three present
    // and paint a ⋯ over one action. The one that rendered stays inline.
    expect(triggerPainted()).toBe(false);
    expect(
      isInPanel(
        document.querySelector("button[aria-label='Close conversation']"),
      ),
    ).toBe(false);
  });

  it("renders nothing at all with no authored members", () => {
    const { container } = render(
      <OverflowBox payload={{}} editMode={false}>
        {[]}
      </OverflowBox>,
    );

    // Not even the bar's always-mounted panel: an authored-empty bucket is known
    // to be empty without running anything.
    expect(container.innerHTML).toBe("");
    expect(panel()).toBeNull();
  });

  it("relocates a plain action into the panel as a labelled row", () => {
    render(
      <OverflowBox payload={{ label: "Row actions" }} editMode={false}>
        <Applicable />
        <Pin />
      </OverflowBox>,
    );

    const button = document.querySelector<HTMLElement>(
      "[role='dialog'] button",
    );
    expect(button).not.toBeNull();
    // An IconButton declares the `"row"` rung, so in the panel its label is
    // visible text rather than an aria-label on a bare icon.
    expect(button?.textContent).toContain("Close conversation");
    expect(
      triggerHost()?.querySelector("button")?.getAttribute("aria-label"),
    ).toBe("Row actions");
  });

  it("keeps a member that is not a plain action as itself", () => {
    render(
      <OverflowBox payload={{}} editMode={false}>
        <Slider />
        <Pin />
      </OverflowBox>,
    );

    const slider = document.querySelector("[role='slider']");
    // It relocated — and it is still a slider, with its own markup and its own
    // value. Nothing transformed it into a labelled row, because it never
    // offered one. That is the whole change.
    expect(isInPanel(slider)).toBe(true);
    expect(slider?.getAttribute("aria-valuenow")).toBe("3");
    expect(triggerPainted()).toBe(true);
  });

  it("renders the members inline in edit mode, so the pen can drag them", () => {
    const { container } = render(
      <OverflowBox payload={{ label: "Row actions" }} editMode={true}>
        <Applicable />
      </OverflowBox>,
    );

    // A closed panel would hide the bucket's members from the drag affordances,
    // so edit mode is a labelled inline box and never the bar.
    expect(
      container.querySelector("button[aria-label='Close conversation']"),
    ).not.toBeNull();
    expect(container.textContent).toContain("Row actions");
    expect(panel()).toBeNull();
  });
});
