import { symbol } from "@plugins/ui/plugins/icons/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { EditableViewSwitcher } from "../components/editable-view-switcher";
import type { ResolvedViewInstance } from "../internal/resolve-instances";
import type { ViewActionsCore, ViewDrafts } from "../internal/use-view-model";
import type { ViewTypeMeta } from "../../core";

/**
 * The strip's chips carry each view's count and dirty dot (`ViewList`'s
 * `countFor` / `dirtyFor` contract), and a dirty active view under drafts is
 * followed by Save view — Save as new view / Discard changes in its menu; on
 * the home view, Save as new view.
 */

const viewIcon = symbol("view-list");

function inst(id: string, name: string): ResolvedViewInstance<ViewTypeMeta> {
  return {
    instance: { id, name, icon: viewIcon, pickedIcon: null, type: "list" },
    viewType: { type: "list", title: "List", icon: viewIcon },
  } as unknown as ResolvedViewInstance<ViewTypeMeta>;
}

const INSTANCES = [inst("all", "All files"), inst("code", "Code")];
const ACTIONS = {
  availableSources: [],
  reorderView: () => {},
} as unknown as ViewActionsCore;

function drafts(): ViewDrafts & {
  [K in keyof ViewDrafts]: ReturnType<typeof vi.fn>;
} {
  return {
    save: vi.fn(),
    discard: vi.fn(() => null),
    restore: vi.fn(),
    saveAsNew: vi.fn(() => "new"),
  } as unknown as ViewDrafts & {
    [K in keyof ViewDrafts]: ReturnType<typeof vi.fn>;
  };
}

function strip(props: {
  activeId: string;
  countFor?: (id: string) => number | undefined;
  dirtyFor?: (id: string) => boolean;
  drafts?: ViewDrafts | null;
}) {
  return render(
    <EditableViewSwitcher
      instances={INSTANCES}
      onSelect={() => {}}
      actions={ACTIONS}
      homeId="all"
      {...props}
    />,
  );
}

const chip = (name: string) => screen.getByRole("button", { name });
/** A view's chip (its sortable wrapper is a button of the same name too). */
const viewChip = (name: string) =>
  document.querySelector<HTMLElement>(
    `[data-view-type][aria-label="${name}"]`,
  )!;

afterEach(cleanup);

describe("EditableViewSwitcher — counts and dirty dots", () => {
  it("draws each known count after its name, none where unknown", () => {
    strip({
      activeId: "all",
      countFor: (id) => (id === "all" ? 29 : undefined),
    });
    expect(viewChip("All files").textContent).toBe("All files29");
    expect(viewChip("Code").textContent).toBe("Code");
  });

  it("draws the dirty dot on a view with unsaved edits only", () => {
    strip({ activeId: "code", dirtyFor: (id) => id === "code" });
    expect(
      viewChip("Code").querySelector('[data-part="dv.view-chip-dirty"]'),
    ).not.toBeNull();
    expect(
      viewChip("All files").querySelector('[data-part="dv.view-chip-dirty"]'),
    ).toBeNull();
  });
});

describe("EditableViewSwitcher — Save view", () => {
  it("shows nothing to save while the active view is clean", () => {
    strip({ activeId: "code", dirtyFor: () => false, drafts: drafts() });
    expect(screen.queryByRole("button", { name: "Save view" })).toBeNull();
  });

  it("shows nothing to save without drafts, dirty or not", () => {
    strip({ activeId: "code", dirtyFor: () => true, drafts: null });
    expect(screen.queryByRole("button", { name: "Save view" })).toBeNull();
  });

  it("saves a dirty view onto itself, or as new / discards from its menu", () => {
    const d = drafts();
    strip({ activeId: "code", dirtyFor: (id) => id === "code", drafts: d });
    act(() => chip("Save view").click());
    expect(d.save).toHaveBeenCalledWith("code");

    act(() => chip("More save options").click());
    act(() =>
      screen.getByRole("menuitem", { name: "Save as new view" }).click(),
    );
    expect(d.saveAsNew).toHaveBeenCalledWith("code", { name: "Code copy" });

    act(() => chip("More save options").click());
    act(() =>
      screen.getByRole("menuitem", { name: "Discard changes" }).click(),
    );
    expect(d.discard).toHaveBeenCalledWith("code");
  });

  it("saves the home view's edits as a new view, never onto it", () => {
    const d = drafts();
    strip({ activeId: "all", dirtyFor: (id) => id === "all", drafts: d });
    expect(screen.queryByRole("button", { name: "Save view" })).toBeNull();
    act(() => chip("Save as new view").click());
    expect(d.saveAsNew).toHaveBeenCalledWith("all", { name: "All files copy" });
    expect(d.save).not.toHaveBeenCalled();
  });
});
