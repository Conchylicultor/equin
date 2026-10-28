/**
 * The pure picker panel over a fixed tree: the tree view (every tag unfolded,
 * ✓ on the selection, "No tag"), the search (path matches, the
 * `Create a / b / c` row bolding only the segments to create) and picking —
 * every write is a spy.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PluginProvider } from "@plugins/framework/plugins/web-sdk/core";
import type { TagRow } from "@plugins/tag-tree/plugins/engine/core";
import { TagPickerPanel } from "../components/tag-picker-panel";
import type { TagPickerOptions, TagPickerWrites } from "../internal/types";

afterEach(cleanup);

const at = new Date(0);
function tag(
  id: string,
  name: string,
  parentId: string | null,
  rank: string,
  color: string | null = null,
): TagRow {
  return {
    id,
    name,
    parentId,
    rank,
    color,
    childColors: null,
    icon: null,
    createdAt: at,
    updatedAt: at,
  };
}

// The mockup's tree: app ▸ website ▸ homepage, chord, places; infra ▸ data-view; theme.
const TAGS: TagRow[] = [
  tag("app", "app", null, "a0", "#7c5cff"),
  tag("web", "website", "app", "a0"),
  tag("home", "homepage", "web", "a0"),
  tag("chord", "chord", "app", "a1", "#ec4899"),
  tag("places", "places", "app", "a2"),
  tag("infra", "infra", null, "a1", "#10b981"),
  tag("dv", "data-view", "infra", "a0"),
  tag("theme", "theme", null, "a2", "#ef6f6c"),
];

function writes(): TagPickerWrites {
  return {
    create: vi.fn(() => Promise.resolve({ id: "new" })),
    createPath: vi.fn(() => Promise.resolve({ id: "leaf", created: ["leaf"] })),
    update: vi.fn(() => Promise.resolve()),
    move: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
  };
}

function renderPanel(
  options: Partial<TagPickerOptions> = {},
  w: TagPickerWrites = writes(),
) {
  const onPick = vi.fn();
  render(
    <PluginProvider plugins={[]}>
      <TagPickerPanel
        tags={TAGS}
        writes={w}
        selected={[]}
        onPick={onPick}
        {...options}
      />
    </PluginProvider>,
  );
  return { onPick, writes: w };
}

const search = () => screen.getByRole("textbox", { name: /search or create/i });
const rowOf = (text: string) => {
  const row = screen.getByText(text).closest("[data-tree-row]");
  if (!row) throw new Error(`no row holds "${text}"`);
  return row as HTMLElement;
};

describe("the tree (no query)", () => {
  it("shows the whole tree unfolded, ✓ on the selected tag", () => {
    renderPanel({ selected: ["home"] });
    expect(search().getAttribute("placeholder")).toBe("Search or create…");
    for (const name of [
      "app",
      "website",
      "homepage",
      "chord",
      "infra",
      "theme",
      "data-view",
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(rowOf("homepage").getAttribute("class")).toContain("bg-selected");
    expect(rowOf("chord").getAttribute("class")).not.toContain("bg-selected");
  });

  it("offers No tag only while something is selected; it picks null", () => {
    const { onPick } = renderPanel({ selected: ["home"], offerNone: true });
    fireEvent.click(screen.getByText("No tag"));
    expect(onPick).toHaveBeenCalledWith(null);
    cleanup();
    renderPanel({ selected: [], offerNone: true });
    expect(screen.queryByText("No tag")).toBeNull();
  });

  it("a click picks the row", () => {
    const { onPick } = renderPanel();
    fireEvent.click(screen.getByText("theme"));
    expect(onPick).toHaveBeenCalledWith("theme");
  });

  it("an excluded tag above a pickable one stays, dimmed and unpickable; others are hidden", () => {
    const { onPick } = renderPanel({
      selected: ["home"],
      exclude: (t) => t.id === "app" || t.id === "theme",
    });
    expect(screen.queryByText("theme")).toBeNull();
    expect(rowOf("app").getAttribute("class")).toContain(
      "text-muted-foreground",
    );
    fireEvent.click(screen.getByText("app"));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("draws rolled-up counts", () => {
    renderPanel({ counts: new Map([["app", 7]]) });
    expect(rowOf("app").textContent).toContain("7");
  });
});

describe("a query", () => {
  it("lists every tag whose path contains it, as its path", () => {
    renderPanel();
    fireEvent.change(search(), { target: { value: "web" } });
    expect(rowOf("homepage").textContent).toBe("app / website / homepage");
    expect(screen.queryByText("chord")).toBeNull();
    expect(screen.queryByText("theme")).toBeNull();
    // Typed as a path, it matches the path.
    fireEvent.change(search(), { target: { value: "app/web" } });
    expect(rowOf("homepage").textContent).toBe("app / website / homepage");
    expect(screen.queryByText("data-view")).toBeNull();
  });

  it("offers Create with only the new segments bold; Enter creates the path and picks its leaf", async () => {
    const { onPick, writes: w } = renderPanel();
    fireEvent.change(search(), { target: { value: "App / website / blog" } });
    const create = screen.getByText(/^Create/);
    const bold = [...create.querySelectorAll("b")].map((b) => b.textContent);
    expect(bold).toEqual(["blog"]);
    expect(create.textContent).toBe("Create App / website / blog");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(w.createPath).toHaveBeenCalledWith(["App", "website", "blog"]);
    await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith("leaf"));
  });

  it("an existing path (any case) offers no Create; Enter picks it", () => {
    const { onPick, writes: w } = renderPanel();
    fireEvent.change(search(), { target: { value: "APP/Website" } });
    expect(screen.queryByText(/^Create/)).toBeNull();
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("web");
    expect(w.createPath).not.toHaveBeenCalled();
  });
});
