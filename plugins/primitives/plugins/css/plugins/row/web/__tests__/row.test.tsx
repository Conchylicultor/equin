import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { Row, type RowFocus } from "../internal/row";

afterEach(cleanup);

/** Point at the row: a hover-revealed cluster mounts its buttons only once the
 *  row is reached (see `row-actions`), so a test reaching for an action does
 *  what a user does first. */
function reachRow() {
  fireEvent.pointerOver(screen.getByRole("button", { name: "label" }));
}

// Pins the structural invariant the `Row` primitive exists to guarantee: a
// clickable row that carries interactive `actions` must NEVER emit a
// <button>/<a> nested inside another <button>/<a> (invalid DOM whose failure is
// silent — the action click is swallowed or falls through to the row). The
// element is inferred from props (href → a, onClick → button, else div); there
// is no `as`, so the bad combination cannot be expressed.
describe("Row — no nested interactive elements", () => {
  it("renders the action as a sibling of the row's primary button, never nested", () => {
    render(
      <Row onClick={() => {}} actions={<button data-testid="act">x</button>}>
        label
      </Row>,
    );
    reachRow();
    const action = screen.getByTestId("act");
    // The action's nearest button ancestor is itself — it is not inside the
    // row's primary <button>.
    expect(action.closest("button")).toBe(action);
    // The row still exposes a real, keyboard-accessible primary button named by
    // its children.
    expect(screen.getByRole("button", { name: "label" })).toBeTruthy();
  });

  it("isolates the action click from the row onClick", () => {
    const rowClick = vi.fn();
    const actionClick = vi.fn();
    render(
      <Row onClick={rowClick} actions={<button data-testid="act">x</button>}>
        label
      </Row>,
    );
    reachRow();
    fireEvent.click(screen.getByTestId("act"));
    expect(actionClick).toHaveBeenCalledTimes(0); // (sanity: separate spy)
    expect(rowClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "label" }));
    expect(rowClick).toHaveBeenCalledTimes(1);
  });

  it("fires the action's own handler when clicked", () => {
    const actionClick = vi.fn();
    render(
      <Row
        onClick={() => {}}
        actions={
          <button data-testid="act" onClick={actionClick}>
            x
          </button>
        }
      >
        label
      </Row>,
    );
    reachRow();
    fireEvent.click(screen.getByTestId("act"));
    expect(actionClick).toHaveBeenCalledTimes(1);
  });
});

// Pins the convergence: `Row` owns the trailing slot's PLACEMENT and nothing
// else — the reveal itself belongs to the `row-actions` primitive, so a row's
// cluster cannot drift from a tree's or a table's. Asserting the rendered
// mechanism (the anchor group on the row, the coupled hidden state on the
// cluster) is what catches `Row` quietly re-acquiring a reveal of its own.
describe("Row — the trailing cluster is the row-actions primitive", () => {
  it("anchors the reveal on the row and hides the cluster inertly at rest", () => {
    const { container } = render(
      <Row onClick={() => {}} actions={<button data-testid="act">x</button>}>
        label
      </Row>,
    );
    // The reveal group + the positioning context the cluster pins against ride
    // the row box itself.
    expect(container.firstElementChild!.className).toContain(
      "group/row-actions",
    );
    reachRow();
    // At rest the cluster is invisible AND inert — never one without the other,
    // or the hidden cluster parks a live click-target over the row's trailing
    // edge.
    const cluster = screen.getByTestId("act").closest(".opacity-0");
    expect(cluster).not.toBeNull();
    expect(cluster!.className).toContain("pointer-events-none");
  });

  it("keeps an actionsAlwaysVisible cluster visible and in flow", () => {
    render(
      <Row
        onClick={() => {}}
        actionsAlwaysVisible
        actions={<button data-testid="act">x</button>}
      >
        label
      </Row>,
    );
    const action = screen.getByTestId("act");
    expect(action.closest(".opacity-0")).toBeNull();
    // In flow at the row's trailing edge, not pinned over it.
    expect(action.closest(".ml-auto")).not.toBeNull();
    expect(action.closest(".absolute")).toBeNull();
  });
});

describe("Row — element inference (no `as` prop)", () => {
  it("href → <a>", () => {
    const { container } = render(<Row href="/x">link</Row>);
    expect(container.querySelector("a")).toBeTruthy();
    expect(container.querySelector("button")).toBeNull();
  });

  it("onClick → <button>", () => {
    const { container } = render(<Row onClick={() => {}}>btn</Row>);
    const root = container.firstElementChild!;
    expect(root.tagName).toBe("BUTTON");
  });

  it("disabled (no onClick) → still a <button>", () => {
    const { container } = render(<Row disabled>btn</Row>);
    expect(container.querySelector("button")).toBeTruthy();
  });

  it("neither → non-interactive <div>", () => {
    const { container } = render(<Row>plain</Row>);
    const root = container.firstElementChild!;
    expect(root.tagName).toBe("DIV");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("no-actions interactive row is a single <button> (no split wrapper)", () => {
    const { container } = render(<Row onClick={() => {}}>solo</Row>);
    const root = container.firstElementChild!;
    expect(root.tagName).toBe("BUTTON");
    // No inner button wrapper — the row IS the button.
    expect(root.querySelector("button")).toBeNull();
  });
});

// Pins who owns the row's focus indicator. The control a `Row` renders is
// SYNTHESIZED — it is the row box until the row gains `actions` and an inner
// <button> after that — so the ring is painted by the BOX on every path and the
// inner control's own UA outline is suppressed. Without these, the split path
// silently regresses to two indicators (the box's ring plus the control's
// outline) or to none at all.
describe("Row — the row owns its focus ring", () => {
  it("carries both focus utilities on the box, on every path", () => {
    // Non-interactive <div>, interactive <button>, and the split container:
    // same two classes, because each one is inert where it cannot match rather
    // than branched away.
    for (const row of [
      <Row key="plain">plain</Row>,
      <Row key="btn" onClick={() => {}}>
        btn
      </Row>,
      <Row key="split" onClick={() => {}} actions={<button>x</button>}>
        split
      </Row>,
    ]) {
      const { container } = render(row);
      const box = container.firstElementChild!;
      expect(box.className).toContain("focus-ring");
      expect(box.className).toContain("focus-ring-from");
      cleanup();
    }
  });

  it("nominates the split path's control and suppresses its own outline", () => {
    render(
      <Row onClick={() => {}} actions={<button data-testid="act">x</button>}>
        label
      </Row>,
    );
    const control = screen.getByRole("button", { name: "label" });
    // `focus-ring-from` is `:has(> [data-focus-ring]:focus-visible)`, so the
    // marker has to be on the box's direct child — the control itself.
    expect(control.getAttribute("data-focus-ring")).toBe("");
    expect(control.parentElement).toBe(control.closest(".focus-ring-from"));
    // The box paints the ring, so the UA outline would be a second indicator.
    expect(control.className).toContain("outline-none");
  });

  it("never marks the box itself, so `:has(> …)` cannot match on the single path", () => {
    const { container } = render(<Row onClick={() => {}}>solo</Row>);
    const box = container.firstElementChild!;
    expect(box.hasAttribute("data-focus-ring")).toBe(false);
    expect(box.querySelector("[data-focus-ring]")).toBeNull();
  });
});

// Pins the capability contract: callers get `focus()`, never the node. The
// point is that the SAME call lands on the right element on both paths — which
// is exactly what the old node-handing ref could not do, because on the split
// path the node it handed out was an unfocusable <div>.
describe("Row — focusRef is a capability, not a node", () => {
  it("focuses the row's own button on the single-element path", () => {
    const focusRef = createRef<RowFocus>();
    render(
      <Row focusRef={focusRef} onClick={() => {}}>
        solo
      </Row>,
    );
    focusRef.current!.focus();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "solo" }),
    );
  });

  it("focuses the inner control on the split path", () => {
    const focusRef = createRef<RowFocus>();
    render(
      <Row
        focusRef={focusRef}
        onClick={() => {}}
        actions={<button data-testid="act">x</button>}
      >
        label
      </Row>,
    );
    focusRef.current!.focus();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "label" }),
    );
  });

  it("hands `ref` the row box while `focusRef` focuses a different node", () => {
    const ref = createRef<HTMLElement>();
    const focusRef = createRef<RowFocus>();
    const { container } = render(
      <Row
        ref={ref}
        focusRef={focusRef}
        onClick={() => {}}
        actions={<button data-testid="act">x</button>}
      >
        label
      </Row>,
    );
    // `ref` is the outermost element — what a drag source or a
    // scroll-into-view measures.
    expect(ref.current).toBe(container.firstElementChild);
    focusRef.current!.focus();
    // …and it is emphatically not what took focus.
    expect(document.activeElement).not.toBe(ref.current);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "label" }),
    );
  });

  it("throws when the row renders no control at all", () => {
    const focusRef = createRef<RowFocus>();
    render(<Row focusRef={focusRef}>plain</Row>);
    // The old ref quietly called `.focus()` on an unfocusable <div>; a caller
    // bug that does nothing and says nothing is the failure this replaces.
    expect(() => focusRef.current!.focus()).toThrow(/focusable control/);
  });
});

// A selected row reads brighter than its neighbours: the accent's own text
// colour rides the selected fill (`--selected`, default = the accent), on both
// paths (the box carries the chrome).
describe("Row — selected text", () => {
  it("paints the accent text colour on a selected accent row", () => {
    const { container } = render(
      <Row selected onClick={() => {}}>
        label
      </Row>,
    );
    const box = container.firstElementChild!;
    expect(box.classList.contains("bg-selected")).toBe(true);
    expect(box.classList.contains("text-accent-foreground")).toBe(true);
  });

  it("leaves an unselected row's text colour alone", () => {
    const { container } = render(<Row onClick={() => {}}>label</Row>);
    expect(
      container.firstElementChild!.classList.contains("text-accent-foreground"),
    ).toBe(false);
  });

  it("paints it on the split path's box too", () => {
    const { container } = render(
      <Row selected onClick={() => {}} actions={<button>x</button>}>
        label
      </Row>,
    );
    expect(
      container.firstElementChild!.classList.contains("text-accent-foreground"),
    ).toBe(true);
  });
});
