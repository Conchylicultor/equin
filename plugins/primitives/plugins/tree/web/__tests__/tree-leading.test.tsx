import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  PluginProvider,
  type LoadedPlugin,
} from "@plugins/framework/plugins/web-sdk/core";
import { TreeLeading } from "../internal/tree-leading";
import { TreeGuides } from "../internal/tree-guides";
import { Tree } from "../slots";

/**
 * The row head's geometry with no `Tree.Disclosure` contributed — the column
 * disclosure, the tree-disclosure region's default: the chevron box and the
 * icon are two cells of the row (so the row's gap spaces them, which the
 * density indent = chevron + gap assumes), the chevron box is
 * `--tree-chevron-w` wide on every row, and only a row with children has a
 * chevron.
 */

const plugin = {
  id: "tree-leading-test",
  description: "tree leading fixture",
  contributions: [],
  slots: Tree,
} as unknown as LoadedPlugin;

function head(props: {
  hasChildren: boolean;
  icon?: boolean;
  depth?: number;
  guides?: boolean;
}) {
  const { container } = render(
    <PluginProvider plugins={[plugin]}>
      <div data-testid="row">
        <TreeLeading
          depth={props.depth ?? 0}
          hasChildren={props.hasChildren}
          isOpen={false}
          onToggle={() => {}}
          icon={props.icon ? <span data-icon /> : undefined}
          guides={props.guides}
        />
      </div>
    </PluginProvider>,
  );
  return container.querySelector<HTMLElement>("[data-testid=row]")!;
}

afterEach(cleanup);

describe("TreeLeading: default column disclosure", () => {
  it("a parent: chevron box, then the icon — both direct cells of the row", () => {
    const row = head({ hasChildren: true, icon: true });
    const cells = [...row.children] as HTMLElement[];
    expect(cells).toHaveLength(2);
    expect(cells[0]!.tagName).toBe("BUTTON");
    expect(cells[0]!.getAttribute("aria-label")).toBe("Expand");
    expect(cells[0]!.className).toContain("w-tree-chevron");
    // Faint at rest, full on row hover or keyboard focus; a ring for
    // keyboard focus only.
    expect(cells[0]!.className).toContain("opacity-40");
    expect(cells[0]!.className).toContain("group-hover/tree-row:opacity-100");
    expect(cells[0]!.className).toContain("focus-visible:opacity-100");
    expect(cells[0]!.className).toContain("focus-ring");
    expect(cells[1]!.querySelector("[data-icon]")).not.toBeNull();
  });

  it("a leaf: the chevron box's width reserved, no expander", () => {
    const row = head({ hasChildren: false, icon: true });
    const cells = [...row.children] as HTMLElement[];
    expect(cells).toHaveLength(2);
    expect(row.querySelector("button")).toBeNull();
    expect(cells[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(cells[0]!.className).toContain("w-tree-chevron");
    expect(cells[1]!.querySelector("[data-icon]")).not.toBeNull();
  });

  it("an icon-less row: the same chevron box alone", () => {
    const parent = head({ hasChildren: true });
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]!.className).toContain("w-tree-chevron");
    cleanup();
    const leaf = head({ hasChildren: false });
    expect(leaf.children).toHaveLength(1);
    expect(leaf.children[0]!.className).toContain("w-tree-chevron");
    expect(leaf.querySelector("button")).toBeNull();
  });
});

describe("TreeGuides: one line per level at --tree-guide-x", () => {
  it("tiles one indent step per level, the line at the guide offset", () => {
    const { container } = render(<TreeGuides depth={2} />);
    const box = container.querySelector<HTMLElement>("[data-tree-guides]")!;
    expect(box.style.width).toBe("calc(2 * var(--tree-indent))");
    expect(box.style.backgroundSize).toContain("var(--tree-indent)");
    expect(box.style.backgroundImage).toContain("var(--tree-guide-x)");
  });
});
