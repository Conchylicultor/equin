/**
 * The bookmarks bar over its real hook, with the live read and the endpoints
 * stubbed: it reads the collection's default window, renders nothing while
 * that read is pending or empty, and offers "More" while the window can grow —
 * kept up, loading, while a grow is in flight (a growing window reports
 * `canGrow: false`, so a button gated on `canGrow` alone would vanish instead).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mounting live-state otherwise schedules real log flushes at module eval —
// the convention the live-state hazard suites established.
vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

const state = vi.hoisted(() => ({
  result: undefined as unknown,
  queries: [] as unknown[],
  loadMore: 0,
}));

vi.mock("@plugins/network/plugins/live/web", () => ({
  useLive: (_collection: unknown, query: unknown) => {
    state.queries.push(query);
    return state.result;
  },
}));

vi.mock("@plugins/infra/plugins/endpoints/web", () => ({
  useEndpointMutation: () => ({ mutateAsync: () => Promise.resolve() }),
}));

vi.mock("@plugins/apps/plugins/browser/plugins/shell/web", () => ({
  useBrowserNav: () => ({ navigate: () => {} }),
  Favicon: () => null,
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResourceError } from "@plugins/primitives/plugins/live-state/web";
import { bookmarkIdKind, type BookmarkRow } from "../../core";
import { BookmarksBar } from "../components/bookmarks-bar";

const refetch = () => Promise.resolve();
const ROW: BookmarkRow = {
  id: bookmarkIdKind.key("b1"),
  url: "https://example.com/a",
  title: "A",
  createdAt: new Date(0),
};

function settled(
  rows: BookmarkRow[],
  paging: { canGrow: boolean; growing: boolean },
) {
  state.result = {
    status: "ready",
    data: rows,
    refetch,
    ...paging,
    loadMore: () => {
      state.loadMore += 1;
    },
  };
}

beforeEach(() => {
  state.result = { status: "loading", refetch };
  state.queries = [];
  state.loadMore = 0;
});

afterEach(() => {
  cleanup();
});

describe("BookmarksBar", () => {
  it("reads the default window, and renders nothing while it is pending", () => {
    const { container } = render(<BookmarksBar />);
    expect(state.queries.length).toBeGreaterThan(0);
    expect(state.queries.every((q) => q === undefined)).toBe(true);
    expect(container.innerHTML).toBe("");
  });

  it("says a failed read, with Retry, instead of rendering nothing", () => {
    state.result = {
      status: "error",
      error: new ResourceError("loader-failed", "boom", null),
      refetch,
    };
    render(<BookmarksBar />);
    expect(screen.getByText(/Couldn't load bookmarks: boom/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("renders nothing when there are no bookmarks", () => {
    settled([], { canGrow: false, growing: false });
    const { container } = render(<BookmarksBar />);
    expect(container.innerHTML).toBe("");
  });

  it("offers no More when the window is not full", () => {
    settled([ROW], { canGrow: false, growing: false });
    render(<BookmarksBar />);
    expect(screen.getByText("example.com")).toBeDefined();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("grows the window from More when it is full", () => {
    settled([ROW], { canGrow: true, growing: false });
    render(<BookmarksBar />);
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveProperty("disabled", false);
    fireEvent.click(more);
    expect(state.loadMore).toBe(1);
  });

  it("keeps More up, loading, while a grow is in flight", () => {
    settled([ROW], { canGrow: false, growing: true });
    render(<BookmarksBar />);
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveProperty("disabled", true);
    expect(more.getAttribute("data-loading")).toBe("true");
  });
});
