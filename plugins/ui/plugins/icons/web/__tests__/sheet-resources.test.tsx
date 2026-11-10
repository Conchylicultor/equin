import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SymbolSheet, type SheetEntry } from "../internal/symbol-sheet";
import { useSheetResources } from "../internal/sheet-resources";

/**
 * A sheet renders a symbol's resources (an active form's masks) only while
 * something draws that symbol — every rendered resource is restyled by every
 * whole-document style recalc.
 */

afterEach(cleanup);

const mask = (id: string) =>
  `<mask id="${id}-k"><rect fill="white"/></mask><mask id="${id}-o"><rect/></mask>`;
const symbolOf = (id: string) =>
  `<symbol id="${id}" viewBox="0 0 24 24">${mask(id)}<g mask="url(#${id}-k)"><circle r="8"/></g></symbol>`;

const entries: SheetEntry[] = [
  {
    key: "fam",
    markup: `<svg xmlns="http://www.w3.org/2000/svg">${symbolOf("sr-a")}${symbolOf("sr-b")}<symbol id="sr-plain"><path d="M0 0"/></symbol></svg>`,
    attribute: "data-icon-family",
  },
];

function Draw({ id }: { id: string | null }) {
  useSheetResources(id);
  return null;
}

function renderedMasks(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-sheet-resources] mask")].map(
    (m) => m.id,
  );
}

describe("SymbolSheet resources", () => {
  it("renders no resource until a symbol holding one is drawn", () => {
    const { container } = render(
      <SymbolSheet entries={entries} attribute="data-icon-families" />,
    );
    expect(renderedMasks(container)).toEqual([]);
    // The symbols are all there, their masks taken out.
    expect(container.querySelectorAll("symbol")).toHaveLength(3);
    expect(container.querySelectorAll("symbol mask")).toHaveLength(0);
  });

  it("renders a drawn symbol's resources, in a rendered subtree, until its last drawer leaves", () => {
    const { container, rerender } = render(
      <>
        <SymbolSheet entries={entries} attribute="data-icon-families" />
        <Draw id="sr-a" />
        <Draw id="sr-a" />
        <Draw id="sr-plain" />
      </>,
    );
    expect(renderedMasks(container)).toEqual(["sr-a-k", "sr-a-o"]);
    const res = container.querySelector("[data-sheet-resources]")!;
    expect(res.closest('[style*="display: none"]')).toBeNull();

    rerender(
      <>
        <SymbolSheet entries={entries} attribute="data-icon-families" />
        <Draw id="sr-a" />
        <Draw id="sr-b" />
      </>,
    );
    expect(renderedMasks(container)).toEqual([
      "sr-a-k",
      "sr-a-o",
      "sr-b-k",
      "sr-b-o",
    ]);

    rerender(
      <>
        <SymbolSheet entries={entries} attribute="data-icon-families" />
        <Draw id={null} />
        <Draw id="sr-b" />
      </>,
    );
    expect(renderedMasks(container)).toEqual(["sr-b-k", "sr-b-o"]);
  });

  it("renders the masks of icons mounting in the same commit as the sheet", () => {
    const { container } = render(
      <>
        <SymbolSheet entries={entries} attribute="data-icon-families" />
        <Draw id="sr-b" />
      </>,
    );
    expect(renderedMasks(container)).toEqual(["sr-b-k", "sr-b-o"]);
  });

  it("renders the resources of a symbol drawn before its sheet landed", () => {
    const { container, rerender } = render(<Draw id="sr-a" />);
    rerender(
      <>
        <Draw id="sr-a" />
        <SymbolSheet entries={entries} attribute="data-icon-families" />
      </>,
    );
    expect(renderedMasks(container)).toEqual(["sr-a-k", "sr-a-o"]);
  });
});
