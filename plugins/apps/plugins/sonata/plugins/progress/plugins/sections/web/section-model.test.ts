import { describe, expect, test } from "bun:test";
import type { SectionAnnotation } from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  SECTION_DOT_CLASSES,
  sectionAt,
  sectionColorIndex,
  sectionKind,
} from "./section-model";

function section(start: number, end: number, name: string): SectionAnnotation {
  return { type: "section", start, end, data: { name }, source: "authored" };
}

describe("sectionKind", () => {
  test("strips trailing digits and whitespace, lower-cases", () => {
    expect(sectionKind("Chorus 2")).toBe("chorus");
    expect(sectionKind("Chorus2")).toBe("chorus");
    expect(sectionKind("  Verse 10  ")).toBe("verse");
    expect(sectionKind("Pre-Chorus")).toBe("pre-chorus");
  });
});

describe("sectionColorIndex", () => {
  test("same kind → same colour", () => {
    const n = SECTION_DOT_CLASSES.length;
    expect(sectionColorIndex("Chorus", n)).toBe(
      sectionColorIndex("chorus 2", n),
    );
    expect(sectionColorIndex("Verse", n)).toBe(sectionColorIndex("Verse 3", n));
  });

  test("in range and deterministic", () => {
    for (const name of ["Intro", "Verse", "Chorus", "Bridge", "Outro", ""]) {
      const i = sectionColorIndex(name, 9);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(9);
      expect(sectionColorIndex(name, 9)).toBe(i);
    }
  });
});

describe("sectionAt", () => {
  const sections = [
    section(0, 8, "Intro"),
    section(8, 24, "Verse"),
    section(24, 40, "Chorus"),
  ];

  test("start inclusive, end exclusive", () => {
    expect(sectionAt(sections, 0)?.data.name).toBe("Intro");
    expect(sectionAt(sections, 7.99)?.data.name).toBe("Intro");
    expect(sectionAt(sections, 8)?.data.name).toBe("Verse");
    expect(sectionAt(sections, 39)?.data.name).toBe("Chorus");
  });

  test("outside every section → undefined", () => {
    expect(sectionAt(sections, 40)).toBeUndefined();
    expect(sectionAt(sections, -1)).toBeUndefined();
    expect(sectionAt([], 3)).toBeUndefined();
  });
});
