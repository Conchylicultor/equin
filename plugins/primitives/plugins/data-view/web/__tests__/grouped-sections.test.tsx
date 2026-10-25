import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { DataViewSection } from "../../core";
import { GroupedSections } from "../internal/grouped-sections";
import { SectionBody } from "../components/section-body";
import { symbol } from "@plugins/ui/plugins/icons/core";

afterEach(cleanup);

const SECTIONS = [
  { key: "queue", label: "Queue", count: { kind: "exact", n: 6 }, entries: [] },
  {
    key: "working",
    label: "Working",
    count: { kind: "exact", n: 2 },
    entries: [],
  },
] as unknown as DataViewSection<unknown>[];

function renderSections(
  headerActions?: (s: DataViewSection<unknown>) => ReactNode,
  collapsed: string[] = [],
) {
  return render(
    <GroupedSections
      sections={SECTIONS}
      headerActions={headerActions}
      collapsedSections={new Set(collapsed)}
    >
      {(section) => <div>rows of {section.key}</div>}
    </GroupedSections>,
  );
}

describe("GroupedSections — group header", () => {
  it("one run: label, count beside it, the rule, then the chevron", () => {
    renderSections();
    const header = screen.getByRole("button", { name: "Queue6" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    // The count is part of the label's run, in the group role.
    const count = header.querySelector('[data-part="dv.group-count"]')!;
    expect(count.textContent).toBe("6");
    expect(count.getAttribute("class")).toContain("text-group-count-ink");
    // The rule's box sits after the count, out of the a11y tree, shown only
    // under the `rule` style (a style query on the theme token).
    const rule = header.querySelector('[data-part="dv.group-rule"]')!;
    const ruleBox = rule.closest('[aria-hidden="true"]')!;
    expect(ruleBox.getAttribute("class")).toContain("hidden");
    expect(ruleBox.getAttribute("class")).toContain(
      "[@container_style(--group-header-style:rule)]:block",
    );
    expect(
      count.compareDocumentPosition(ruleBox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The chevron trails the run, hidden at rest while the section is open.
    const chevron = header.lastElementChild!;
    expect(chevron.tagName.toLowerCase()).toBe("svg");
    expect(chevron.getAttribute("data-part")).toBe("dv.group-chevron");
    expect(chevron.getAttribute("class")).toContain("opacity-0");
  });

  it("reveals the chevron on hover", () => {
    renderSections();
    const header = screen.getByRole("button", { name: "Queue6" });
    fireEvent.pointerEnter(header);
    expect(header.lastElementChild!.getAttribute("class")).toContain(
      "opacity-100",
    );
  });

  it("a collapsed section keeps its chevron and fades its label", () => {
    renderSections(undefined, ["queue"]);
    const header = screen.getByRole("button", { name: "Queue6" });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.lastElementChild!.getAttribute("class")).toContain(
      "opacity-100",
    );
    const label = header.querySelector('[data-part="dv.group-label"]')!;
    expect(label.getAttribute("class")).toContain("text-faint-foreground");
    const open = screen.getByRole("button", { name: "Working2" });
    expect(
      open.querySelector('[data-part="dv.group-label"]')!.getAttribute("class"),
    ).toContain("text-group-label-ink");
  });

  it("the label wears the pill only under the `pill` style", () => {
    renderSections();
    const label = document.querySelector('[data-part="dv.group-label"]')!;
    expect(label.getAttribute("class")).toContain(
      "[@container_style(--group-header-style:pill)]:bg-group-pill-fill",
    );
  });

  it("keeps a section's header actions in the trailing cluster", () => {
    renderSections((s) =>
      s.key === "queue" ? <button type="button">Fold</button> : null,
    );
    const action = screen.getByRole("button", { name: "Fold" });
    const header = screen.getByRole("button", { name: "Queue6" });
    // A sibling of the control, never inside it.
    expect(header.contains(action)).toBe(false);
    expect(header.parentElement!.contains(action)).toBe(true);
  });

  it("the band pays the rail and the header keeps its row pad", () => {
    renderSections();
    const header = screen.getByRole("button", { name: "Queue6" });
    // The header row itself follows no rail (its own `p-row` stays), so its
    // label lands on the rows' text column; its sticky band pays the rail.
    expect(header.className).not.toContain("rail-follow");
    expect(header.className).toContain("p-row");
    expect(header.closest(".rail-follow")).not.toBeNull();
  });
});

// The fold line is the SectionBody's (see section-body.test.tsx); this pins only
// that a grouped view's body — fold line included — is hidden with its group.
describe("GroupedSections — section body", () => {
  it("a collapsed section hides its body, fold line included", () => {
    const sections = [
      {
        key: "done",
        label: "Done",
        count: { kind: "exact", n: 5 },
        entries: [],
        fold: { hidden: 3, open: false },
      },
    ] as unknown as DataViewSection<unknown>[];
    render(
      <GroupedSections
        sections={sections}
        collapsedSections={new Set(["done"])}
      >
        {(section) => (
          <SectionBody
            section={section}
            foldLines={{ open: new Set(), setOpen: () => {} }}
          >
            <div>rows of {section.key}</div>
          </SectionBody>
        )}
      </GroupedSections>,
    );
    expect(screen.queryByText("rows of done")).toBeNull();
    expect(screen.queryByRole("button", { name: "… 3 more" })).toBeNull();
  });
});

// Nested sections (a forest-shaped grouping): tree order, each level folding on
// its own, a collapsed parent hiding every descendant.
describe("GroupedSections — nested sections", () => {
  const exact = (n: number) => ({ kind: "exact", n });
  const NESTED = [
    {
      key: "app",
      label: "app",
      count: exact(4),
      entries: [{ key: "p2", row: {} }],
      nesting: { depth: 0, parentKey: null },
      identity: { swatch: "#7c5cff" },
    },
    {
      key: "website",
      label: "website",
      count: exact(2),
      entries: [],
      nesting: { depth: 1, parentKey: "app" },
    },
    {
      key: "homepage",
      label: "homepage",
      count: exact(2),
      entries: [{ key: "p1", row: {} }],
      nesting: { depth: 2, parentKey: "website" },
    },
    {
      key: "chord",
      label: "chord",
      count: exact(1),
      entries: [{ key: "p3", row: {} }],
      nesting: { depth: 1, parentKey: "app" },
    },
  ] as unknown as DataViewSection<unknown>[];

  function renderNested(collapsed: string[]) {
    return render(
      <GroupedSections sections={NESTED} collapsedSections={new Set(collapsed)}>
        {(section) => <div>rows of {section.key}</div>}
      </GroupedSections>,
    );
  }

  // A header's text is its label then its count ("app" + "4"): strip the
  // trailing tally to read the label.
  const headers = () =>
    screen
      .getAllByRole("button")
      .map((b) => (b.textContent ?? "").replace(/\d+\+?$/, ""))
      .filter((t) => t !== "");

  it("renders every section in tree order, each header indented by its depth", () => {
    renderNested([]);
    expect(headers()).toEqual(["app", "website", "homepage", "chord"]);
    const depthOf = (label: string) =>
      screen
        .getByRole("button", { name: new RegExp(`^${label}\\d`) })
        .closest("[data-section-depth]")
        ?.getAttribute("data-section-depth") ?? "0";
    expect(["app", "website", "homepage", "chord"].map(depthOf)).toEqual([
      "0",
      "1",
      "2",
      "1",
    ]);
    // A parent's own rows sit above its child sections.
    expect(screen.getByText("rows of app")).toBeTruthy();
    // A section with no rows of its own draws its header alone.
    expect(screen.queryByText("rows of website")).toBeNull();
  });

  it("draws the section's swatch as a dot before its label", () => {
    const { container } = renderNested([]);
    const dots = container.querySelectorAll("[data-section-swatch]");
    expect(dots).toHaveLength(1);
    expect((dots[0] as HTMLElement).style.backgroundColor).toBe(
      "rgb(124, 92, 255)",
    );
  });

  it("collapsing a parent hides every descendant, header and rows", () => {
    renderNested(["app"]);
    expect(headers()).toEqual(["app"]);
    expect(screen.queryByText("rows of app")).toBeNull();
    expect(screen.queryByText("rows of homepage")).toBeNull();
    expect(screen.queryByText("rows of chord")).toBeNull();
  });

  it("children fold independently: a collapsed child hides only its subtree", () => {
    renderNested(["website"]);
    expect(headers()).toEqual(["app", "website", "chord"]);
    expect(screen.getByText("rows of app")).toBeTruthy();
    expect(screen.queryByText("rows of homepage")).toBeNull();
    expect(screen.getByText("rows of chord")).toBeTruthy();
  });
});

describe("GroupedSections — identity chip", () => {
  const withIdentity = [
    {
      key: "doing",
      label: "Doing",
      identity: { icon: symbol("list"), tint: "--categorical-3" },
      count: { kind: "exact", n: 2 },
      entries: [],
    },
    {
      key: "tinted",
      label: "Tinted",
      // A tint alone draws no chip (the chip is the glyph's) — its dot.
      identity: { tint: "--categorical-4" },
      count: { kind: "exact", n: 1 },
      entries: [],
    },
  ] as unknown as DataViewSection<unknown>[];

  function chips() {
    render(
      <GroupedSections sections={withIdentity}>
        {(section) => <div>rows of {section.key}</div>}
      </GroupedSections>,
    );
    return [...document.querySelectorAll('[data-part="dv.group-chip"]')];
  }

  it("draws the chip before the label, tinted, only with an icon", () => {
    const found = chips();
    expect(found).toHaveLength(1);
    const chip = found[0] as HTMLElement;
    expect(chip.style.color).toBe("var(--categorical-3)");
    expect(chip.querySelector("svg")).not.toBeNull();
    // Before the label, in the same run.
    const label = chip.parentElement!.querySelector(
      '[data-part="dv.group-label"]',
    )!;
    expect(label.textContent).toBe("Doing");
    expect(
      chip.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a colour without a glyph draws the dot, the token's colour through its var", () => {
    render(
      <GroupedSections sections={withIdentity}>
        {(section) => <div>rows of {section.key}</div>}
      </GroupedSections>,
    );
    const dots = [...document.querySelectorAll("[data-section-swatch]")];
    expect(dots).toHaveLength(1);
    expect((dots[0] as HTMLElement).style.backgroundColor).toBe(
      "var(--categorical-4)",
    );
  });

  it("no chip for a section without identity (every existing surface)", () => {
    renderSections();
    expect(document.querySelector('[data-part="dv.group-chip"]')).toBeNull();
    // The parts are still stamped for the metrics diff.
    for (const part of [
      "dv.group-header",
      "dv.group-label",
      "dv.group-count",
      "dv.group-rule",
      "dv.group-chevron",
      "dv.group",
    ]) {
      expect(document.querySelector(`[data-part="${part}"]`)).not.toBeNull();
    }
  });
});
