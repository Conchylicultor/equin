import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  SegmentedControl,
  type SegmentedOption,
} from "../internal/toggle-chip";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Every radio has a name: a labelled option's is its label, an icon-only
// option's is its (required, string) tooltip.
describe("SegmentedControl — accessible names", () => {
  it("names an icon-only option's radio by its tooltip", () => {
    render(
      <SegmentedControl
        options={[
          { id: "a", icon: <svg />, tooltip: "Docked" },
          { id: "b", label: "Solo" },
        ]}
        value="a"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("radio", { name: "Docked" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Solo" })).toBeTruthy();
  });

  it("throws on an empty label, which would draw a nameless radio", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const options: SegmentedOption<string>[] = [{ id: "a", label: "" }];
    expect(() =>
      render(
        <SegmentedControl options={options} value="a" onChange={() => {}} />,
      ),
    ).toThrow(/empty label/);
  });
});
