import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { DataViewSection } from "../../core";
import { GroupedSections } from "../internal/grouped-sections";
import { SectionBody } from "../components/section-body";

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
  headerStyle?: "standard" | "quiet",
  headerActions?: (s: DataViewSection<unknown>) => ReactNode,
) {
  return render(
    <GroupedSections
      sections={SECTIONS}
      headerStyle={headerStyle}
      headerActions={headerActions}
    >
      {(section) => <div>rows of {section.key}</div>}
    </GroupedSections>,
  );
}

describe("GroupedSections — header style", () => {
  it("renders the identical node for an absent and a `standard` style", () => {
    // `useId` mints a fresh id per mount; everything else must match exactly.
    const html = (el: HTMLElement) => el.innerHTML.replace(/_r_\w+_/g, "_id_");
    const absent = html(renderSections().container);
    cleanup();
    const standard = html(renderSections("standard").container);
    expect(standard).toBe(absent);
  });

  it("standard: label, count beside it, a rule, the chevron at the end", () => {
    renderSections("standard");
    // The count is part of the label's run, in the code role.
    const header = screen.getByRole("button", { name: "Queue6" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.querySelector(".text-code")!.textContent).toBe("6");
    // The hairline fills the slack after the run, out of the a11y tree.
    const rule = header.querySelector('[data-slot="separator"]')!;
    expect(rule.closest('[aria-hidden="true"]')).not.toBeNull();
    // No chevron leads; it sits at the far end, outside the control, faint.
    expect(header.querySelector("svg")).toBeNull();
    const chevron = header.parentElement!.querySelector("svg")!;
    expect(chevron.getAttribute("class")).toContain("text-faint-foreground");
    expect(chevron.getAttribute("class")).not.toContain("opacity-0");
  });

  it("standard: keeps a section's header actions before the chevron", () => {
    renderSections("standard", (s) =>
      s.key === "queue" ? <button type="button">Fold</button> : null,
    );
    const action = screen.getByRole("button", { name: "Fold" });
    const header = screen.getByRole("button", { name: "Queue6" });
    expect(header.contains(action)).toBe(false);
    expect(header.parentElement!.contains(action)).toBe(true);
  });

  it("quiet: count right after the label, chevron trailing the run", () => {
    renderSections("quiet");
    const header = screen.getByRole("button", { name: "Queue6" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.lastElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(header.lastElementChild!.getAttribute("class")).toContain(
      "opacity-0",
    );
  });

  it("quiet: keeps a section's header actions in the trailing cluster", () => {
    renderSections("quiet", (s) =>
      s.key === "queue" ? <button type="button">Fold</button> : null,
    );
    const action = screen.getByRole("button", { name: "Fold" });
    const header = screen.getByRole("button", { name: "Queue6" });
    // A sibling of the control, never inside it.
    expect(header.contains(action)).toBe(false);
  });

  it("quiet: the band pays the rail and the header keeps its row pad", () => {
    renderSections("quiet");
    const header = screen.getByRole("button", { name: "Queue6" });
    // The header row itself follows no rail (its own `p-row` stays), so its
    // label lands on the rows' text column; its sticky band pays the rail.
    expect(header.className).not.toContain("rail-follow");
    expect(header.className).toContain("p-row");
    expect(header.closest(".rail-follow")).not.toBeNull();
  });

  it("standard: the header row itself pays the rail", () => {
    renderSections("standard");
    // The count rides the row's actions, so the control is the split path's
    // inner button and the rail is on the row BOX around it.
    const header = screen.getByRole("button", { name: "Queue6" });
    expect(header.parentElement!.className).toContain("rail-follow");
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
      swatch: "#7c5cff",
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
