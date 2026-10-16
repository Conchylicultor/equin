import { describe, it, expect, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { ControlPanel } from "../internal/namespace";
import { ControlPanelPane } from "../internal/control-panel-pane";
import { ControlPanelPopover } from "../internal/control-panel-popover";

afterEach(cleanup);

// The element is inferred from props — there is no `as`. Same rule as `css/row`'s
// `Row`, so an author learns it once, and a clickable row can never be declared
// as a `<button>` that then nests interactive content.
describe("ControlPanel.Row — the host element is inferred", () => {
  it("renders an <a> when given href", () => {
    render(
      <ControlPanel>
        <ControlPanel.Row href="/somewhere">Link row</ControlPanel.Row>
      </ControlPanel>,
    );
    const row = screen.getByText("Link row").closest("a, button, div");
    expect(row?.tagName).toBe("A");
  });

  it("renders a <button> when given onSelect", () => {
    render(
      <ControlPanel>
        <ControlPanel.Row onSelect={vi.fn()}>Button row</ControlPanel.Row>
      </ControlPanel>,
    );
    expect(screen.getByRole("button", { name: "Button row" })).toBeTruthy();
  });

  it("renders a non-interactive <div> with neither", () => {
    render(
      <ControlPanel>
        <ControlPanel.Row>Plain row</ControlPanel.Row>
      </ControlPanel>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    const row = screen.getByText("Plain row").closest("div.cp-row");
    expect(row).not.toBeNull();
  });
});

// The row's SECOND construction. Adding `actions` is the one prop that changes
// the row's markup shape, so both shapes are pinned here: a future edit that
// "unifies" them breaks whichever of the two it did not have in mind.
describe("ControlPanel.Row — `actions` splits the row", () => {
  it("makes the box non-interactive and the SELECTION the button", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Row
          onSelect={vi.fn()}
          actions={
            <button type="button" aria-label="Delete preset">
              x
            </button>
          }
        >
          Recently updated
        </ControlPanel.Row>
      </ControlPanel>,
    );
    // The row box is a plain `<div>`; the click target moved inside it.
    const box = container.querySelector(".cp-row")!;
    expect(box.tagName).toBe("DIV");
    const select = box.querySelector("[data-cp-select]")!;
    expect(select.tagName).toBe("BUTTON");
    expect(select.getAttribute("data-focus-ring")).toBe("");

    // And the two interactive things are SIBLINGS, never nested — which is the
    // whole reason this construction exists. A `<button>` inside a `<button>` is
    // invalid DOM, and it is what the trailing cell used to be forbidden for.
    const del = screen.getByRole("button", { name: "Delete preset" });
    expect(select.contains(del)).toBe(false);
    expect(box.contains(del)).toBe(true);
    expect(del.closest("button")).toBe(del);
  });

  it("passes the panel's tracks through the selection as a subgrid", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Row
          select="radio"
          checked
          onSelect={vi.fn()}
          trailing="3 rules"
          actions={<button type="button" aria-label="Delete" />}
        >
          Recently updated
        </ControlPanel.Row>
      </ControlPanel>,
    );
    const box = container.querySelector(".cp-row")!;
    // Two direct children: the selection (spanning every track but the last)
    // and the trailing cell (the last). jsdom applies no stylesheet, so what is
    // asserted is the CONTRACT the CSS reads — the rendered geometry is
    // `fixtures/control-panel/row-actions-rail`'s job.
    const select = box.querySelector("[data-cp-select]")!;
    expect([...box.children]).toEqual([
      select,
      box.querySelector('[data-cp-cell="trailing"]'),
    ]);
    const classes = select.className.split(/\s+/);
    expect(classes).toContain("grid-cols-subgrid");
    expect(classes).toContain("col-[1/-2]");
    // NO column gap of its own: a subgrid inherits the parent grid's, and
    // restating it is how the leading cells drift off the panel's rail.
    expect(classes.filter((c) => /^gap/.test(c))).toEqual([]);
    // The three leading cells live inside it, in order, and the selection still
    // reports its own state from the node that IS the control.
    expect(
      [...select.children].map((c) => c.getAttribute("data-cp-cell")),
    ).toEqual(["gutter", "icon", "label"]);
    expect(screen.getByRole("radio", { name: "Recently updated" })).toBe(
      select,
    );
    // The occupancy mark is one level deeper now, and the panel's `:has()` scan
    // is a descendant scan — so the icon track is still reserved.
    expect(container.querySelectorAll("[data-cp-icon]").length).toBe(1);
  });

  it("scopes `disabled` to the selection, so the actions stay live", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Row
          select="radio"
          checked={false}
          disabled
          onSelect={vi.fn()}
          actions={<button type="button" aria-label="Delete" />}
        >
          No matching fields
        </ControlPanel.Row>
      </ControlPanel>,
    );
    // The dimming and the inertness ride the inner region; the box stays live.
    // A preset whose fields have all left the schema cannot be applied and is
    // exactly the one you want to delete, so this is the prop's honest meaning
    // rather than a concession.
    const box = container.querySelector(".cp-row")!;
    const select = box.querySelector("[data-cp-select]") as HTMLButtonElement;
    expect(select.disabled).toBe(true);
    expect(select.className).toContain("opacity-50");
    const boxClasses = box.className.split(/\s+/);
    expect(boxClasses).not.toContain("opacity-50");
    expect(boxClasses).not.toContain("pointer-events-none");
    expect(
      (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("lights the ROW from the selection's focus, never from an action's", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Row
          onSelect={vi.fn()}
          actions={<button type="button" aria-label="Delete" />}
        >
          Recently updated
        </ControlPanel.Row>
      </ControlPanel>,
    );
    // Keyed on `:has(> [data-focus-ring]:focus-visible)`, and the selection is
    // a direct child — so the whole row lights (the shared menu highlight) for
    // the row's own focus, and not when an action button inside the cluster is
    // focused (it rings itself). `:focus-within` would light both at once.
    const classes = container.querySelector(".cp-row")!.className.split(/\s+/);
    expect(classes).toContain(
      "has-[>[data-focus-ring]:focus-visible]:menu-row-lit",
    );
    expect(classes).not.toContain("focus-visible:menu-row-lit");
    expect(classes).not.toContain("focus-within:menu-row-lit");
  });

  it("leaves a row WITHOUT actions exactly as it was", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Row onSelect={vi.fn()} trailing="3">
          Recently updated
        </ControlPanel.Row>
      </ControlPanel>,
    );
    // ~50 call sites render this shape: the inferred element IS the row box, and
    // the four cells are its DIRECT children. The split construction must stay
    // opt-in — "unifying" the two is what would silently move every one of them.
    const box = container.querySelector(".cp-row")!;
    expect(box.tagName).toBe("BUTTON");
    expect(box).toBe(screen.getByRole("button", { name: /Recently updated/ }));
    expect(
      [...box.children].map((c) => c.getAttribute("data-cp-cell")),
    ).toEqual(["gutter", "icon", "label", "trailing"]);
    expect(box.querySelector("[data-cp-select]")).toBeNull();
    expect(box.className.split(/\s+/)).toContain("focus-visible:menu-row-lit");
  });
});

// One selection language per meaning. The single-select row is the one most
// likely to drift back: a highlighted row reads as HOVER, so "selected" has to
// be a mark that appears, never a fill.
describe("ControlPanel.Row — one selection language per meaning", () => {
  it('select="radio" marks the row with a checkmark and NO background fill', () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Row select="radio" checked onSelect={vi.fn()}>
          Status
        </ControlPanel.Row>
      </ControlPanel>,
    );
    const row = screen.getByRole("radio", { name: "Status" });
    expect(row.getAttribute("aria-checked")).toBe("true");

    // A glyph is drawn…
    expect(container.querySelector("svg")).not.toBeNull();
    // …and the row's own classes carry no resting background at all. Only a
    // `hover:`-prefixed one is allowed.
    const resting = row.className
      .split(/\s+/)
      .filter((c) => c.startsWith("bg-"));
    expect(resting).toEqual([]);
  });

  it('select="radio" draws no mark when unchecked', () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Row select="radio" checked={false} onSelect={vi.fn()}>
          Status
        </ControlPanel.Row>
      </ControlPanel>,
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(
      screen
        .getByRole("radio", { name: "Status" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it('select="check" renders the shared CheckboxIndicator', () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Row select="check" checked onSelect={vi.fn()}>
          Title
        </ControlPanel.Row>
      </ControlPanel>,
    );
    expect(screen.getByRole("checkbox", { name: "Title" })).toBeTruthy();
    // The indicator box is the selection-indicator primitive's: a filled
    // `rounded-checkbox` square, never a hand-rolled box with a radius class.
    expect(container.querySelector(".rounded-checkbox")).not.toBeNull();
  });

  it('select="switch" owns the trailing cell and ignores a passed `trailing`', () => {
    render(
      <ControlPanel>
        <ControlPanel.Row
          select="switch"
          checked
          trailing="ignored"
          onSelect={vi.fn()}
        >
          Show sub-tasks
        </ControlPanel.Row>
      </ControlPanel>,
    );
    const row = screen.getByRole("switch", { name: "Show sub-tasks" });
    expect(row.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("ignored")).toBeNull();

    // The switch is the LAST grid cell (the trailing track), not the leading one
    // — that is what keeps the icon rail empty and aligned on a settings panel.
    const cells = Array.from(row.children);
    const knob = row.querySelector('[data-state="checked"]');
    expect(knob).not.toBeNull();
    expect(cells.at(-1)?.contains(knob!)).toBe(true);
  });
});

// The container separates its children — an author never places a divider. That
// inversion is what makes a conditionally-null section leave no orphan rule.
describe("ControlPanel — the container draws the hairline", () => {
  it("pairs the band container with the inset owner on ONE box", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Properties">
          <ControlPanel.Row>Title</ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanel>,
    );
    // The first band's rule is cancelled by painting over the box's own
    // padding-box top edge, which is only where the rule lands because the SAME
    // element insets the content by `--cp-panel-pad`. Split them onto two boxes
    // and the mask misses by exactly that pad.
    const body = container.querySelector(".cp-body")!;
    expect(body.classList.contains("cp-panel")).toBe(true);
  });

  it("marks a Section and a Footer as bands, and nothing else", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Properties">
          <ControlPanel.Row>Title</ControlPanel.Row>
        </ControlPanel.Section>
        <ControlPanel.Section label="Group by">
          <ControlPanel.Subhead>Build</ControlPanel.Subhead>
          <ControlPanel.RuleList>
            <ControlPanel.Row>Status</ControlPanel.Row>
          </ControlPanel.RuleList>
          <ControlPanel.Empty>Nothing yet</ControlPanel.Empty>
        </ControlPanel.Section>
        <ControlPanel.Footer>
          <ControlPanel.Row tone="danger" onSelect={vi.fn()}>
            Clear filter
          </ControlPanel.Row>
        </ControlPanel.Footer>
      </ControlPanel>,
    );
    // Three bands: two sections and the footer. `RuleList`, `Empty` and
    // `Subhead` are NOT bands — all three are used INSIDE a section (a filter is
    // one sentence read down the page; a sub-head names the rows under it), so
    // marking any of them would draw a rule in the middle of a band, and for the
    // sub-head between a heading and its own rows.
    const bands = Array.from(container.querySelectorAll(".cp-band"));
    expect(bands.length).toBe(3);
    expect(container.querySelector("[data-cp-footer]")?.classList).toContain(
      "cp-band",
    );

    // And no band places separator chrome of its own (a hand-rolled `border-t` /
    // `h-px bg-border` hairline) — the rule is drawn FOR it.
    for (const band of bands) {
      const classes = band.className.split(/\s+/);
      expect(classes).not.toContain("border-t");
      expect(classes).not.toContain("h-px");
      expect(classes).not.toContain("cp-body");
    }
  });

  it("draws a Subhead with no inset of its own, so it lands on the rail", () => {
    render(
      <ControlPanel>
        <ControlPanel.Section label="Properties">
          <ControlPanel.Subhead>Build</ControlPanel.Subhead>
          <ControlPanel.Row>Duration</ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanel>,
    );
    // jsdom applies no stylesheet, so this reads what `useRailGuard` reads off a
    // live panel: the classes the member DECLARES. A sub-head names a RUN, which
    // is the eyebrow's rung, and it reaches the panel's content edge by carrying
    // nothing at all — the same way `Empty` does. The rendered geometry is
    // `fixtures/control-panel/subhead-rail`'s job.
    const classes = screen.getByText("Build").className.split(/\s+/);
    expect(classes.filter((c) => /^-?p[xls]-/.test(c))).toEqual([]);
    expect(classes.filter((c) => c.startsWith("rail-"))).toEqual([]);
  });

  it("keeps the panel stack out of the layout, so ONE box spaces the bands", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Stack
          root={
            <ControlPanel.Section>
              <ControlPanel.Row>Rule</ControlPanel.Row>
            </ControlPanel.Section>
          }
        />
      </ControlPanel>,
    );
    // The stack is `display: contents`: a box the layout does not generate, so
    // the bands inside it are the panel body's own flex items however deeply the
    // framework's `renderIsolated` lineage spans wrap them. A second `cp-body`
    // here would put a second first-band mask at the wrong y.
    expect(container.querySelectorAll(".cp-body").length).toBe(1);
    const stack = container.querySelector(".cp-body > div")!;
    expect((stack as HTMLElement).style.display).toBe("contents");
  });
});

// The two leading tracks are derived from what the PANEL puts in them. jsdom
// applies no stylesheet, so what is asserted here is the CONTRACT the CSS reads:
// which cells declare themselves occupied. The rendered geometry is gated by
// `fixtures/control-panel/derived-tracks` in a real browser.
describe("ControlPanel — the leading tracks are derived from content", () => {
  it("publishes no occupancy marks when no row has a handle or an icon", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Properties">
          <ControlPanel.Row>Assignee</ControlPanel.Row>
          <ControlPanel.Row trailing="3">Status</ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanel>,
    );
    // Neither track is claimed, so the panel's `:has()` scan finds nothing and
    // both columns drop: a two-track row, flush on the panel's own content
    // inset, with no reserved gutter and no reserved icon column.
    expect(container.querySelectorAll("[data-cp-handle]").length).toBe(0);
    expect(container.querySelectorAll("[data-cp-icon]").length).toBe(0);
    // The cells are still all there — the CSS hides the two that lost their
    // track. An unhidden empty cell would auto-place into the track that took
    // its place and shove the label one column over, which is why each is
    // named rather than inferred by position.
    const row = container.querySelector(".cp-row")!;
    expect(
      [...row.children].map((c) => c.getAttribute("data-cp-cell")),
    ).toEqual(["gutter", "icon", "label", "trailing"]);
  });

  it("marks the gutter occupied when a row hangs a drag handle", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Properties">
          <ControlPanel.Row handle>Priority</ControlPanel.Row>
          <ControlPanel.Row>Assignee</ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanel>,
    );
    // ONE row claims it and the whole panel keeps the track — which is the
    // point: derive it per row and the handle-less row's label would sit one
    // column left of its neighbour's.
    const gutters = container.querySelectorAll('[data-cp-cell="gutter"]');
    expect(gutters.length).toBe(2);
    expect(container.querySelectorAll("[data-cp-handle]").length).toBe(1);
  });

  it("marks the icon column occupied by an icon OR a selection indicator", () => {
    const { container: withIcon } = render(
      <ControlPanel>
        <ControlPanel.Row icon={<span>i</span>}>Visibility</ControlPanel.Row>
      </ControlPanel>,
    );
    expect(withIcon.querySelectorAll("[data-cp-icon]").length).toBe(1);

    cleanup();
    // A selection row occupies that column exactly as a glyph does, so a panel
    // of checkboxes reserves it and every label in it still shares one x.
    const { container: withSelect } = render(
      <ControlPanel>
        <ControlPanel.Row select="check" checked onSelect={vi.fn()}>
          Status
        </ControlPanel.Row>
      </ControlPanel>,
    );
    expect(withSelect.querySelectorAll("[data-cp-icon]").length).toBe(1);
  });

  it("does NOT count a switch — its indicator is in the trailing cell", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Effects">
          <ControlPanel.Row select="switch" checked onSelect={vi.fn()}>
            Reverb
          </ControlPanel.Row>
          <ControlPanel.Row select="switch" checked={false} onSelect={vi.fn()}>
            Chorus
          </ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanel>,
    );
    // A switch-only panel reserves NOTHING in front of its labels: no handle, no
    // icon, so a two-track row (label | trailing) flush on the panel's own
    // inset. Reserving the column here cost every label in the panel 26px for a
    // track that painted nothing.
    expect(container.querySelectorAll("[data-cp-icon]").length).toBe(0);
    expect(container.querySelectorAll("[data-cp-handle]").length).toBe(0);
    // The indicator really is in the trailing cell, which is WHY the leading
    // one is free — the two facts are one fact.
    const row = screen.getByRole("switch", { name: "Reverb" });
    const cells = [...row.children];
    expect(
      cells.find((c) => c.getAttribute("data-cp-cell") === "icon")?.textContent,
    ).toBe("");
    expect(
      cells
        .find((c) => c.getAttribute("data-cp-cell") === "trailing")
        ?.querySelector('[data-state="checked"]'),
    ).not.toBeNull();
  });

  it("lets a switch row carry an icon, and counts THAT", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Effects">
          <ControlPanel.Row
            select="switch"
            checked
            icon={<span data-testid="glyph">fx</span>}
            onSelect={vi.fn()}
          >
            Reverb
          </ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanel>,
    );
    // Both cells are occupied, and by different things — the icon leads, the
    // switch trails. Before the union was split this row was unspellable, so the
    // one surface that wanted it put its glyph in the LABEL cell, where it
    // shifted that row's text off the rail every other row sits on.
    const row = screen.getByRole("switch", { name: "Reverb" });
    const cells = [...row.children];
    const leading = cells.find(
      (c) => c.getAttribute("data-cp-cell") === "icon",
    );
    expect(leading?.querySelector('[data-testid="glyph"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-cp-icon]").length).toBe(1);
    expect(
      cells
        .find((c) => c.getAttribute("data-cp-cell") === "trailing")
        ?.querySelector('[data-state="checked"]'),
    ).not.toBeNull();
  });

  it("marks a rule row's gutter, so a builder derives the same track", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.RuleList>
          <ControlPanel.RuleRow
            handle
            prefix="Where"
            field={<span>Status</span>}
            operator={<span>is</span>}
          />
        </ControlPanel.RuleList>
      </ControlPanel>,
    );
    const gutter = container.querySelector(
      '.cp-rule > [data-cp-cell="gutter"]',
    );
    expect(gutter?.hasAttribute("data-cp-handle")).toBe(true);
  });
});

// One grid, shared by every builder — including the one with no operator.
describe("ControlPanel.RuleRow", () => {
  it("sets data-span=field when no operator is given", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.RuleList>
          <ControlPanel.RuleRow
            prefix="Sort by"
            field={<span>Updated</span>}
            value={<span>Descending</span>}
          />
        </ControlPanel.RuleList>
      </ControlPanel>,
    );
    const rule = container.querySelector(".cp-rule")!;
    expect(rule.getAttribute("data-span")).toBe("field");
    expect(rule.querySelector('[data-cp-cell="operator"]')).toBeNull();
  });

  it("leaves data-span unset when an operator IS given", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.RuleList>
          <ControlPanel.RuleRow
            prefix="Where"
            field={<span>Status</span>}
            operator={<span>is none of</span>}
            value={<span>Done</span>}
          />
        </ControlPanel.RuleList>
      </ControlPanel>,
    );
    const rule = container.querySelector(".cp-rule")!;
    expect(rule.getAttribute("data-span")).toBeNull();
    expect(rule.querySelector('[data-cp-cell="operator"]')).not.toBeNull();
  });

  it("renders the remove button with an accessible name", () => {
    render(
      <ControlPanel>
        <ControlPanel.RuleList>
          <ControlPanel.RuleRow
            prefix="Where"
            field={<span>Status</span>}
            operator={<span>is</span>}
            onRemove={vi.fn()}
            removeLabel="Remove filter"
          />
        </ControlPanel.RuleList>
      </ControlPanel>,
    );
    expect(screen.getByRole("button", { name: "Remove filter" })).toBeTruthy();
  });
});

// The value row. Its whole reason to exist is that its cells may hold controls,
// and the only thing making that safe is that its BOX is never a click target.
describe("ControlPanel.Setting — the row holds the control", () => {
  it("renders a <div> host and never a <button>", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Appearance">
          <ControlPanel.Setting
            label="Theme"
            fit="field"
            control={<button type="button">Tangerine</button>}
          />
        </ControlPanel.Section>
      </ControlPanel>,
    );
    const row = container.querySelector(".cp-setting")!;
    expect(row.tagName).toBe("DIV");
    // The ONE button on screen is the control the caller passed. A row host that
    // could become a `<button>` would make that a button inside a button — which
    // is why `ControlPanelSettingProps` carries no `onSelect` and no `href`.
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0]!.textContent).toBe("Tangerine");
  });

  it("marks the value cell whenever the row was given a control", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Appearance">
          <ControlPanel.Setting
            label="Theme"
            fit="field"
            control={<span>Tangerine</span>}
          />
        </ControlPanel.Section>
      </ControlPanel>,
    );
    // DECLARED occupancy, from the prop rather than from the rendered node —
    // same rule as `data-cp-icon`. A control that draws nothing in one state
    // still owns its column, or the panel re-flows the first time it draws.
    expect(container.querySelectorAll("[data-cp-value]").length).toBe(1);
    expect(container.querySelector('[data-cp-cell="value"]')?.textContent).toBe(
      "Tangerine",
    );
  });

  it('a panel of only fit="inline" settings declares no field width', () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Appearance">
          <ControlPanel.Setting
            label="Accent"
            fit="inline"
            control={<span>swatch</span>}
          />
          <ControlPanel.Setting
            label="Avatar"
            fit="inline"
            control={<span>avatar</span>}
          />
        </ControlPanel.Section>
      </ControlPanel>,
    );
    // The cells are occupied — they hold the controls, so the track exists and
    // the cells are not hidden — but NOTHING in the panel claims the panel's
    // field width, so each value cell sizes to its own content. That is the
    // whole of `fit`: the track is derived from occupancy, the WIDTH from `fit`.
    expect(container.querySelectorAll("[data-cp-value]").length).toBe(2);
    expect(container.querySelectorAll('[data-cp-fit="field"]').length).toBe(0);
  });

  it("reserves nothing for a panel whose rows have no control at all", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Content">
          <ControlPanel.Block label="Notes">
            <textarea aria-label="Notes" />
          </ControlPanel.Block>
        </ControlPanel.Section>
      </ControlPanel>,
    );
    // A Block's header is the same row with no value cell, so the panel's
    // `:has()` scan finds no value, no status and no actions — a one-track grid
    // whose label runs the full width of the row.
    expect(container.querySelectorAll("[data-cp-value]").length).toBe(0);
    expect(container.querySelectorAll("[data-cp-status]").length).toBe(0);
    expect(container.querySelectorAll("[data-cp-actions]").length).toBe(0);
  });

  it("keeps status presentational and actions hover-revealed", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Appearance">
          <ControlPanel.Setting
            label="Theme"
            fit="field"
            control={<span>Tangerine</span>}
            status={<span>User</span>}
            actions={
              <button type="button" aria-label="Reset">
                ↺
              </button>
            }
            mark="accent"
            note="Upstream: Default"
          />
        </ControlPanel.Section>
      </ControlPanel>,
    );
    expect(container.querySelectorAll("[data-cp-status]").length).toBe(1);
    expect(container.querySelectorAll("[data-cp-actions]").length).toBe(1);
    // The stripe is a STATE on the row, not a node the author drew — so there is
    // nothing in the markup for a caller to style, mis-place or forget.
    expect(
      container.querySelector(".cp-setting")?.getAttribute("data-cp-mark"),
    ).toBe("");
    // …and the note is a line UNDER the row, never a second line inside it.
    const row = container.querySelector(".cp-setting")!;
    expect(row.textContent).not.toContain("Upstream");
    expect(container.textContent).toContain("Upstream");
  });
});

// `hint` costs no height and no track. Both halves matter: a second line breaks
// invariant #2 in every panel at once, and a leading glyph would open the icon
// column for every row in the panel.
describe("ControlPanel — hint is a tooltip, never a line", () => {
  it("describes the row from a zero-box sibling in the label cell", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Effects">
          <ControlPanel.Row
            select="switch"
            checked
            hint="Applies to new sessions only."
            onSelect={vi.fn()}
          >
            Reverb
          </ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanel>,
    );
    const row = screen.getByRole("switch", { name: "Reverb" });
    const describedBy = row.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    // `getElementById`, not a `#id` selector: `useId()` mints `«r0»`, which is
    // not a valid CSS identifier.
    const description = document.getElementById(describedBy!);
    expect(description?.textContent).toBe("Applies to new sessions only.");
    // It lives INSIDE the label cell and is `sr-only` (position: absolute), so
    // it generates no box in the grid: no track opened, no row height added.
    expect(description?.closest('[data-cp-cell="label"]')).not.toBeNull();
    expect(description?.className).toContain("sr-only");
    // …and it is hidden from the NAME computation, or the row would be called
    // "Reverb Applies to new sessions only." — the `getByRole` above is the
    // assertion that says so.
    expect(description?.getAttribute("aria-hidden")).toBe("true");
    // And it opens no leading column either.
    expect(container.querySelectorAll("[data-cp-icon]").length).toBe(0);
  });

  it("leaves a hintless row exactly as it was", () => {
    render(
      <ControlPanel>
        <ControlPanel.Row onSelect={vi.fn()}>Plain</ControlPanel.Row>
      </ControlPanel>,
    );
    expect(
      screen
        .getByRole("button", { name: "Plain" })
        .hasAttribute("aria-describedby"),
    ).toBe(false);
  });
});

// `description` is the visible twin of `hint`: a second line under the label
// that reserves its own height — a separate prop, because `hint` stays a
// tooltip by contract (above).
describe("ControlPanel — description is a visible second line", () => {
  it("renders the description under the label, inside the label cell", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section label="Page kind">
          <ControlPanel.Row
            select="radio"
            checked
            description="Agents can write all of it."
            onSelect={vi.fn()}
          >
            Agent page
          </ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanel>,
    );
    // The row's NAME is its label alone — the description is not folded in.
    const row = screen.getByRole("radio", { name: "Agent page" });
    const describedBy = row.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description?.textContent).toBe("Agents can write all of it.");
    // Visible, NOT the zero-box `sr-only` a hint uses: it takes a line.
    expect(description?.className).not.toContain("sr-only");
    const cell = description?.closest('[data-cp-cell="label"]');
    expect(cell).not.toBeNull();
    expect(cell?.hasAttribute("data-cp-described")).toBe(true);
    // Under the label, in document order, and wrapping rather than truncating.
    expect(cell?.firstElementChild?.textContent).toBe("Agent page");
    expect(cell?.lastElementChild).toBe(description);
    expect(description?.className).toContain("whitespace-normal");
    // No tooltip trigger wraps it: a description is read, not hovered for.
    expect(container.querySelector("[data-cp-described] .sr-only")).toBeNull();
  });

  it("leaves an undescribed row's label cell a plain single line", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Row onSelect={vi.fn()}>Plain</ControlPanel.Row>
      </ControlPanel>,
    );
    expect(container.querySelector("[data-cp-described]")).toBeNull();
  });
});

// A Section's description is prose about the BAND — not a row, so invariant #2
// never sees it.
describe("ControlPanel.Section — description", () => {
  it("renders under the eyebrow and opens no row", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Section
          label="Retention"
          description="How long finished runs are kept."
        >
          <ControlPanel.Row>Keep for</ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanel>,
    );
    expect(container.textContent).toContain("How long finished runs are kept.");
    // One row in the band, and the description is not in it.
    expect(container.querySelectorAll(".cp-row").length).toBe(1);
    expect(container.querySelector(".cp-row")?.textContent).toBe("Keep for");
  });
});

// The presentation of a Group belongs to the HOST, and there is no correct
// default — so asking without one is an error, not a guess.
describe("ControlPanel.Group — the host owns the presentation", () => {
  it("throws when no host published a policy", () => {
    // React logs the boundary-less render error; the assertion is the throw.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    expect(() =>
      render(
        <ControlPanel>
          <ControlPanel.Stack
            root={
              <ControlPanel.Section>
                <ControlPanel.Group label="Schedule">
                  <ControlPanel.Row>Cadence</ControlPanel.Row>
                </ControlPanel.Group>
              </ControlPanel.Section>
            }
          />
        </ControlPanel>,
      ),
    ).toThrow(/useControlPanelHost/);
    consoleError.mockRestore();
  });

  it("inlines the first level in a pane, and pushes below its budget", () => {
    const { container } = render(
      <ControlPanelPane label="Settings">
        <ControlPanel.Section label="Sources">
          <ControlPanel.Group label="Schedule">
            <ControlPanel.Row>Cadence</ControlPanel.Row>
            <ControlPanel.Group label="Retries" summary="3">
              <ControlPanel.Row>Backoff</ControlPanel.Row>
            </ControlPanel.Group>
          </ControlPanel.Group>
        </ControlPanel.Section>
      </ControlPanelPane>,
    );
    // Depth 0 is inline — a nested rail region, not a margin.
    const region = container.querySelector(".cp-group[data-inline]");
    expect(region).not.toBeNull();
    // Depth 1 is past the pane's budget, so it falls back to a drill row rather
    // than collapsing into nothing.
    expect(container.querySelectorAll(".cp-group[data-inline]").length).toBe(1);
    expect(screen.getByRole("button", { name: /Retries/ })).toBeTruthy();
  });
});

// `indicator="trailing"`: the kind menu's shape — a real glyph leads the row
// and the tick moves to its end. The selection semantics must not move with it.
describe('ControlPanel.Row — indicator="trailing"', () => {
  it("keeps role and aria-checked, and draws the tick in the trailing cell", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Row
          select="radio"
          checked
          indicator="trailing"
          icon={<span data-testid="kind-glyph" />}
          onSelect={vi.fn()}
        >
          Agent page
        </ControlPanel.Row>
      </ControlPanel>,
    );
    const row = screen.getByRole("radio", { name: "Agent page" });
    expect(row.getAttribute("aria-checked")).toBe("true");
    // The leading cell holds the row's own icon…
    const iconCell = container.querySelector('[data-cp-cell="icon"]')!;
    expect(iconCell.contains(screen.getByTestId("kind-glyph"))).toBe(true);
    expect(iconCell.hasAttribute("data-cp-icon")).toBe(true);
    // …and the tick is in the trailing cell.
    const trailing = container.querySelector('[data-cp-cell="trailing"]')!;
    expect(trailing.querySelector("svg")).not.toBeNull();
    expect(iconCell.querySelector("svg")).toBeNull();
  });

  it("keeps an unticked row's mark box, invisible, so ticking moves nothing", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Row
          select="radio"
          checked={false}
          indicator="trailing"
          onSelect={vi.fn()}
        >
          Page
        </ControlPanel.Row>
      </ControlPanel>,
    );
    const mark = container.querySelector('[data-cp-cell="trailing"] svg')!;
    expect(mark.getAttribute("class")).toContain("invisible");
    // No icon, and the mark is not in the leading cell: nothing occupies it.
    expect(container.querySelector("[data-cp-icon]")).toBeNull();
  });

  it("leaves the default indicator in the leading cell", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Row select="radio" checked onSelect={vi.fn()}>
          Status
        </ControlPanel.Row>
      </ControlPanel>,
    );
    const iconCell = container.querySelector('[data-cp-cell="icon"]')!;
    expect(iconCell.querySelector("svg")).not.toBeNull();
    expect(container.querySelector('[data-cp-cell="trailing"] svg')).toBeNull();
  });
});

// `push`: a drill row pushes a page AND says so — the chevron cannot be
// forgotten because there is no other way to push from a row.
describe("ControlPanel.Row — push", () => {
  it("draws a trailing chevron after the value and pushes the page", () => {
    const { container } = render(
      <ControlPanel>
        <ControlPanel.Stack
          root={
            <ControlPanel.Section>
              <ControlPanel.Row
                trailing="Manual"
                push={{
                  key: "sort",
                  title: "Sort",
                  render: () => <div>Sort page</div>,
                  size: "inherit",
                }}
              >
                Sort
              </ControlPanel.Row>
            </ControlPanel.Section>
          }
        />
      </ControlPanel>,
    );
    const trailing = container.querySelector('[data-cp-cell="trailing"]')!;
    expect(trailing.textContent).toBe("Manual");
    const chevron = trailing.querySelector("svg")!;
    expect(chevron.getAttribute("data-icon")).toBe("chevron-right");

    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    expect(screen.getByText("Sort page")).toBeTruthy();
  });

  it("throws when there is no stack to push onto", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    expect(() =>
      render(
        <ControlPanel>
          <ControlPanel.Row
            push={{
              key: "x",
              title: "Nowhere",
              render: () => null,
              size: "inherit",
            }}
          >
            Nowhere
          </ControlPanel.Row>
        </ControlPanel>,
      ),
    ).toThrow(/requires a <ControlPanel.Stack>/);
    consoleError.mockRestore();
  });
});

describe("ControlPanel.Section — label", () => {
  it("draws the shared menu section label, never small caps", () => {
    render(
      <ControlPanel>
        <ControlPanel.Section label="Agents on this page">
          <ControlPanel.Row>Page</ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanel>,
    );
    const label = screen.getByText("Agents on this page");
    expect(label.className).toContain("text-faint-foreground");
    expect(label.className).toContain("font-semibold");
    expect(label.className).not.toContain("uppercase");
  });
});

// The surface takes the width of the page that is SHOWING: a menu-wide root
// widens to the builder role only while a builder page is pushed.
describe("ControlPanelPopover — the showing page's width role", () => {
  it("widens for a pushed page that declares its own size", async () => {
    render(
      <ControlPanelPopover
        open
        onOpenChange={vi.fn()}
        size="menu"
        label="Section options"
        trigger={<button type="button">More</button>}
      >
        <ControlPanel.Section>
          <ControlPanel.Row
            push={{
              key: "filter",
              title: "Filter",
              size: "builder",
              render: () => <div>Filter builder</div>,
            }}
          >
            Filter
          </ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanelPopover>,
    );
    const row = await screen.findByRole("button", { name: /Filter/ });
    const panel = row.closest('[data-slot="popover-content"]')!;
    expect(panel.className).toContain("w-(--popover-width-menu-max)");

    fireEvent.click(row);
    await screen.findByText("Filter builder");
    expect(panel.className).toContain("w-(--popover-width-builder)");
  });

  it("keeps the pushing page's role for an inherit sub-page", async () => {
    render(
      <ControlPanelPopover
        open
        onOpenChange={vi.fn()}
        size="menu"
        label="Section options"
        trigger={<button type="button">More</button>}
      >
        <ControlPanel.Section>
          <ControlPanel.Row
            push={{
              key: "filter",
              title: "Filter",
              size: "builder",
              render: () => (
                <ControlPanel.Section>
                  <ControlPanel.Row
                    push={{
                      key: "group",
                      title: "Filter group",
                      size: "inherit",
                      render: () => <div>Nested group</div>,
                    }}
                  >
                    Open group
                  </ControlPanel.Row>
                </ControlPanel.Section>
              ),
            }}
          >
            Filter
          </ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanelPopover>,
    );
    const row = await screen.findByRole("button", { name: /Filter/ });
    const panel = row.closest('[data-slot="popover-content"]')!;
    fireEvent.click(row);
    fireEvent.click(await screen.findByRole("button", { name: /Open group/ }));
    await screen.findByText("Nested group");
    expect(panel.className).toContain("w-(--popover-width-builder)");
  });
});

// A pushed page is a LIVE view of the group that pushed it — not a snapshot of
// its children at push time. A snapshot is what made a list item's page write
// every edit through a closure over the item as it was when opened (the next
// edit silently reverted the previous one), and kept its page on screen after
// the item was removed.
describe("ControlPanel.Group — a pushed page stays live", () => {
  function Item({ name, show }: { name: string; show: boolean }) {
    return (
      <ControlPanelPane label="Settings">
        <ControlPanel.Section label="Items">
          <ControlPanel.Group label="List">
            {show ? (
              <ControlPanel.Group label="Item">
                <ControlPanel.Row>{name}</ControlPanel.Row>
              </ControlPanel.Group>
            ) : null}
          </ControlPanel.Group>
        </ControlPanel.Section>
      </ControlPanelPane>
    );
  }

  it("re-renders the pushed page with the group's current children", () => {
    const { rerender } = render(<Item name="first" show />);
    fireEvent.click(screen.getByRole("button", { name: /Item/ }));
    expect(screen.getByText("first")).toBeTruthy();
    act(() => rerender(<Item name="second" show />));
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("closes the pushed page when its group goes away", () => {
    const { rerender, container } = render(<Item name="first" show />);
    fireEvent.click(screen.getByRole("button", { name: /Item/ }));
    expect(screen.getByText("first")).toBeTruthy();
    act(() => rerender(<Item name="first" show={false} />));
    expect(screen.queryByText("first")).toBeNull();
    // Back on the root level, which is shown again.
    const root = container.querySelector<HTMLElement>('[data-cp-level="0"]')!;
    expect(root.style.display).toBe("contents");
    expect(container.querySelector('[data-cp-level="1"]')).toBeNull();
  });
});
