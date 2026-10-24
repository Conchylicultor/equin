/**
 * Unit tests for the pure halves of `css:message-names-primitives` — the
 * directory→component-name mapping, the "is this primitive advertised?" test,
 * and the message-block extraction. The check's own end-to-end verdict is what
 * `./equin check css:message-names-primitives` asserts; these lock in the
 * matching rules that decide it, especially the ones that must NOT match.
 */

import { describe, expect, test } from "bun:test";
import { extractMessages, namesPrimitive, pascalCase } from "./index";

describe("pascalCase", () => {
  test("single and hyphenated directory names", () => {
    expect(pascalCase("fill")).toBe("Fill");
    expect(pascalCase("viewport-overlay")).toBe("ViewportOverlay");
    expect(pascalCase("measure-strip")).toBe("MeasureStrip");
  });
});

describe("namesPrimitive", () => {
  test("matches the component name as a whole word", () => {
    expect(namesPrimitive("pick <Fill> for the grow cell", "fill")).toBe(true);
    expect(namesPrimitive("<Scroll axis fill> scrolls", "scroll")).toBe(true);
  });

  test("is case-sensitive — the lowercase prop/helper spelling does not count", () => {
    expect(namesPrimitive("<Scroll axis fill> scrolls", "fill")).toBe(false);
    expect(namesPrimitive("take fillClasses(axis) instead", "fill")).toBe(
      false,
    );
  });

  test("a longer component name does not advertise the shorter one", () => {
    // `Overlay` inside `ViewportOverlay` has no word boundary before it.
    expect(
      namesPrimitive("ViewportOverlay for true fixed inset-0", "overlay"),
    ).toBe(false);
    expect(
      namesPrimitive(
        "ViewportOverlay for true fixed inset-0",
        "viewport-overlay",
      ),
    ).toBe(true);
  });

  test("English prose does not advertise a primitive", () => {
    expect(namesPrimitive("<Text> in a line container truncates", "line")).toBe(
      false,
    );
    expect(namesPrimitive("a grid of cards", "grid")).toBe(false);
  });

  test("the plugin path is the accepted form for a directory whose components differ", () => {
    expect(
      namesPrimitive(
        "<Inset pad> · <Stack gap>  (css/plugins/spacing/web)",
        "spacing",
      ),
    ).toBe(true);
    expect(namesPrimitive("<Inset pad> · <Stack gap>", "spacing")).toBe(false);
  });
});

describe("extractMessages", () => {
  const src = [
    "  docs: { description: 'names Center' },",
    "  messages: {",
    "    // a comment naming <Sticky>",
    '    adhocLayout: "use <Fill>",',
    "  },",
    "  defaultOptions: [],",
    "  create() { return {}; },",
  ].join("\n");

  test("takes only the messages block", () => {
    const messages = extractMessages(src)!;
    expect(messages).toContain("<Fill>");
    // Before the block (the docs description) and after it (create) are excluded.
    expect(messages).not.toContain("Center");
    expect(messages).not.toContain("create");
  });

  test("drops comment lines — a name mentioned only in a comment is advertised to nobody", () => {
    expect(extractMessages(src)!).not.toContain("Sticky");
  });

  test("returns null when the block cannot be located", () => {
    expect(extractMessages("export default {}")).toBeNull();
  });
});
