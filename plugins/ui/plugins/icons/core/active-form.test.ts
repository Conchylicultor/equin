import { describe, expect, test } from "bun:test";
import {
  ACTIVE_ID_TOKEN,
  deriveActiveForm,
  placeActiveIds,
} from "./active-form";

describe("deriveActiveForm", () => {
  test("a glyph of open strokes only has none", () => {
    expect(deriveActiveForm('<path d="M7 10l5 5 5-5"/>')).toBeUndefined();
    expect(
      deriveActiveForm('<line x1="1" y1="1" x2="5" y2="5"/>'),
    ).toBeUndefined();
  });

  test("a lone closed shape is filled, with no masks", () => {
    expect(deriveActiveForm('<circle cx="12" cy="12" r="8"/>')).toBe(
      '<circle cx="12" cy="12" r="8" fill="currentColor"/>',
    );
  });

  test("an open stroke inside a closed shape is cut out of its fill", () => {
    const form = deriveActiveForm(
      '<circle cx="12" cy="12" r="8"/><path d="M9 12l2 2 4-4"/>',
    )!;
    expect(form).toContain(`<mask id="${ACTIVE_ID_TOKEN}-k"`);
    // The check cuts the fill (black in the -k mask) …
    expect(form).toContain(
      '<path d="M9 12l2 2 4-4" stroke="black" fill="none"/>',
    );
    // … the circle is filled through it, and the check drawn through -o.
    expect(form).toContain(
      `<g mask="url(#${ACTIVE_ID_TOKEN}-k)"><circle cx="12" cy="12" r="8" fill="currentColor"/></g>`,
    );
    expect(form).toContain(
      `<g mask="url(#${ACTIVE_ID_TOKEN}-o)"><path d="M9 12l2 2 4-4"/></g>`,
    );
  });

  test("a closed shape nested in another is cut out, not filled", () => {
    const form = deriveActiveForm(
      '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
    )!;
    expect(form).toContain(
      `<g mask="url(#${ACTIVE_ID_TOKEN}-k)"><circle cx="12" cy="12" r="9" fill="currentColor"/></g>`,
    );
    expect(form).toContain(
      '<circle cx="12" cy="12" r="3" stroke="black" fill="none"/>',
    );
  });

  test("a filled dot cuts out its fill and keeps its own stroke", () => {
    const form = deriveActiveForm(
      '<rect x="4" y="6" width="16" height="12"/><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/>',
    )!;
    expect(form).toContain(
      '<circle cx="9" cy="12" r="1" fill="black" stroke="none"/>',
    );
  });

  test("a closed path beside an open straight stroke still fills (Lucide's pin)", () => {
    const form = deriveActiveForm('<path d="M12 17v5M9 4h6v8l2 3H7l2-3z"/>');
    expect(form).toBe(
      '<path d="M12 17v5M9 4h6v8l2 3H7l2-3z" fill="currentColor"/>',
    );
  });

  test("an open curve does not fill", () => {
    expect(
      deriveActiveForm('<path d="M4 12a8 8 0 0 1 16 0"/>'),
    ).toBeUndefined();
  });

  test("a part keeps its ancestors — motion and transform — in every copy", () => {
    const form = deriveActiveForm(
      '<g data-motion="bob"><rect x="4" y="4" width="16" height="16"/><path d="M8 12h8"/></g>',
    )!;
    expect(form).toContain(
      '<g data-motion="bob"><rect x="4" y="4" width="16" height="16" fill="currentColor"/></g>',
    );
    expect(form).toContain(
      '<g data-motion="bob"><path d="M8 12h8" stroke="black" fill="none"/></g>',
    );
  });

  test("containment is measured through transforms", () => {
    // The small square sits inside the big one only once translated.
    const form = deriveActiveForm(
      '<rect x="0" y="0" width="10" height="10"/><g transform="translate(3 3)"><rect x="0" y="0" width="2" height="2"/></g>',
    )!;
    expect(form).toContain(
      '<g transform="translate(3 3)"><rect x="0" y="0" width="2" height="2" stroke="black" fill="none"/></g>',
    );
  });

  test("placeActiveIds writes every mask id under one prefix", () => {
    const form = deriveActiveForm(
      '<circle cx="12" cy="12" r="8"/><path d="M9 12h6"/>',
    )!;
    const placed = placeActiveIds(form, "x1");
    expect(placed).not.toContain(ACTIVE_ID_TOKEN);
    expect(placed).toContain('<mask id="x1-k"');
    expect(placed).toContain('mask="url(#x1-o)"');
  });

  test("anything but shapes and groups throws", () => {
    expect(() => deriveActiveForm("<text>a</text>")).toThrow(/<text>/);
  });
});
