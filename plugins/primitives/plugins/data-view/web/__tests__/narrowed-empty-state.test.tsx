/**
 * Zero rows under a search or a filter is "nothing matches", with the way to
 * take the narrowing off — never the surface's "nothing here yet".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NarrowedEmptyState } from "../components/narrowed-empty-state";

afterEach(cleanup);

function mount(query: string, filtered: boolean) {
  const onClearSearch = vi.fn();
  const onClearFilter = vi.fn();
  render(
    <NarrowedEmptyState
      query={query}
      filtered={filtered}
      onClearSearch={onClearSearch}
      onClearFilter={onClearFilter}
    />,
  );
  return { onClearSearch, onClearFilter };
}

describe("NarrowedEmptyState", () => {
  it("names the filter and clears it", () => {
    const { onClearFilter } = mount("", true);
    expect(
      screen.getByText("Nothing matches the current filter."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(onClearFilter).toHaveBeenCalledOnce();
  });

  it("names the query and clears it", () => {
    const { onClearSearch } = mount("foo", false);
    expect(screen.getByText("Nothing matches “foo”.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear filter" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onClearSearch).toHaveBeenCalledOnce();
  });

  it("offers both when both narrow", () => {
    mount("foo", true);
    expect(
      screen.getByText("Nothing matches “foo” with the current filter."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear filter" })).toBeTruthy();
  });
});
