import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ChordGridCover } from "../components/chord-grid-cover";
import { coverChords } from "../internal/cover-chords";

afterEach(cleanup);

describe("ChordGridCover", () => {
  it("draws one filled, non-interactive chord box per chord", () => {
    const { container, getByRole } = render(
      <ChordGridCover chords={coverChords("C G Am F Dm E7 A")} />,
    );
    const boxes = container.querySelectorAll(".chord-box");
    expect(boxes.length).toBe(6);
    for (const box of boxes) expect(box.hasAttribute("data-filled")).toBe(true);
    expect(container.querySelector("button")).toBeNull();
    expect(getByRole("img").getAttribute("aria-label")).toBe(
      "Chords: C, G, Am, F, Dm, E7",
    );
  });
});
