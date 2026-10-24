import { describe, expect, test } from "bun:test";
import {
  MATERIAL_FAMILY,
  defineIconFamily,
  type IconFamilyId,
  type SymbolName,
} from "@plugins/ui/plugins/icons/core";
import type { IconSource } from "@plugins/ui/plugins/icons/web";
import {
  appOnlyGlyphs,
  cellOf,
  fallbackBadge,
  fallsBack,
  familyColumns,
  familyCounts,
  familyLabels,
  matrixRows,
  setRows,
  statusOptions,
  tileGroupOptions,
  tileRows,
  type ResolveSource,
} from "./model";

const fake = defineIconFamily({
  id: "fake",
  label: "Fake",
  stroke: 1.5,
  coverage: "fallback",
  fallback: "lib",
  glyphs: {
    x: { body: '<path d="M4 4l16 16"/>' },
    metronome: { body: '<path d="M8 20l4-16 4 16z"/>' },
    swing: { body: '<path d="M4 12h16"/>' },
  },
  symbols: { close: "x" },
});

const strict = defineIconFamily({
  id: "tight",
  label: "Tight",
  stroke: 1.5,
  coverage: "strict",
  glyphs: { x: { body: '<path d="M4 4l16 16"/>' } },
  symbols: { close: "x" },
});

const NAMES: SymbolName[] = ["close", "search", "settings"];

/** A stand-in for `resolveIconSource` over the fake families and a library mapping `search`. */
const resolve: ResolveSource = (name, family): IconSource => {
  if (family === MATERIAL_FAMILY) return { kind: "own", glyph: name };
  if (family === "lib") {
    return name === "search"
      ? { kind: "own", glyph: name }
      : { kind: "fallback", family: MATERIAL_FAMILY };
  }
  if (name === "close") return { kind: "own", glyph: "x" };
  if (family === "tight") return { kind: "gap", family };
  return name === "search"
    ? { kind: "fallback", family: "lib" }
    : { kind: "fallback", family: MATERIAL_FAMILY };
};

describe("debug icons model", () => {
  test("Material leads the columns; a fallback family names its next family", () => {
    const columns = familyColumns([fake, strict]);
    expect(columns.map((c) => [c.id, c.kind, c.fallbackLabel])).toEqual([
      [MATERIAL_FAMILY, "material", undefined],
      ["fake", "inline", "lib"],
      ["tight", "inline", undefined],
    ]);
  });

  test("a row's status is the worst cell over the columns shown", () => {
    const columns = familyColumns([fake, strict]);
    const rows = matrixRows(NAMES, columns, resolve).filter(
      (r) => r.kind === "symbol",
    );
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ["close", "own"],
      ["search", "gap"],
      ["settings", "gap"],
    ]);
    const lenient = matrixRows(NAMES, familyColumns([fake]), resolve).filter(
      (r) => r.kind === "symbol",
    );
    expect(lenient.map((r) => r.status)).toEqual([
      "own",
      "fallback",
      "fallback",
    ]);
  });

  test("counts and badges follow the resolver", () => {
    expect(familyCounts(NAMES, "fake", resolve)).toEqual({
      own: 1,
      fallback: 2,
      gap: 0,
      total: 3,
    });
    expect(familyCounts(NAMES, "tight", resolve).gap).toBe(2);
    const labelOf = (id: IconFamilyId) =>
      id === "lib" ? "Lucide" : familyLabels([fake, strict])(id);
    expect(fallbackBadge(resolve("search", "fake"), labelOf)).toBe("L");
    expect(fallbackBadge(resolve("settings", "fake"), labelOf)).toBe("M");
    expect(fallbackBadge(resolve("close", "fake"), labelOf)).toBeUndefined();
    expect(fallbackBadge(resolve("search", "tight"), labelOf)).toBeUndefined();
  });

  test("an inline family is an app set per app picking it; the rest are libraries", () => {
    const columns = familyColumns([fake, strict]);
    const rows = setRows(
      columns,
      [
        { appId: "a", appName: "Alpha", family: "fake" },
        { appId: "b", appName: "Beta", family: MATERIAL_FAMILY },
      ],
      (family) => familyCounts(NAMES, family, resolve),
    );
    expect(
      rows.map((r) => [r.key, r.group, r.title, r.apps, r.appOnly]),
    ).toEqual([
      [`family:${MATERIAL_FAMILY}`, "library", "Material", ["Beta"], 0],
      ["app:a", "app", "Alpha", ["Alpha"], 2],
      ["family:tight", "app", "Tight", [], 0],
    ]);
    // own/total stay about the manifest's names.
    expect(rows[1]!.counts.total).toBe(NAMES.length);
  });

  test("an inline family's app-only glyphs are the glyphs no symbol maps to", () => {
    expect(appOnlyGlyphs(fake)).toEqual([
      fake.icon("metronome"),
      fake.icon("swing"),
    ]);
    expect(appOnlyGlyphs(strict)).toEqual([]);
    expect(familyColumns([fake])[0]!.appOnly).toEqual([]);
  });

  test("app-only glyphs are matrix rows of their own, drawn in their family's column only", () => {
    const columns = familyColumns([fake, strict]);
    const rows = matrixRows(NAMES, columns, resolve);
    const glyphs = rows.filter((r) => r.kind === "glyph");
    expect(glyphs.map((r) => [r.key, r.name, r.status])).toEqual([
      ["glyph:fake/metronome", "metronome", "only:fake"],
      ["glyph:fake/swing", "swing", "only:fake"],
    ]);
    const metronome = glyphs[0]!;
    expect(cellOf(metronome, "fake")).toEqual({ kind: "glyph" });
    expect(cellOf(metronome, "tight")).toEqual({ kind: "absent" });
    expect(cellOf(metronome, MATERIAL_FAMILY)).toEqual({ kind: "absent" });
    expect(fallbackBadge(cellOf(metronome, "fake"), () => "X")).toBeUndefined();
    // They never fall back, so "Fallbacks only" drops them.
    expect(rows.filter(fallsBack).map((r) => r.name)).toEqual([
      "search",
      "settings",
    ]);
    expect(statusOptions(columns).map((o) => o.value)).toEqual([
      "gap",
      "fallback",
      "own",
      "only:fake",
    ]);
    // A hidden family's glyphs leave with its column.
    const without = matrixRows(NAMES, familyColumns([strict]), resolve);
    expect(without.some((r) => r.kind === "glyph")).toBe(false);
  });

  test("By set: a family's app-only glyphs follow its names, in a group of their own", () => {
    const columns = familyColumns([fake]);
    const tiles = tileRows(NAMES, columns, resolve, false);
    expect(
      tiles.filter((t) => t.family === "fake").map((t) => [t.name, t.group]),
    ).toEqual([
      ["close", "fake"],
      ["search", "fake"],
      ["settings", "fake"],
      ["metronome", "only:fake"],
      ["swing", "only:fake"],
    ]);
    expect(tileGroupOptions(columns).map((o) => o.value)).toEqual([
      MATERIAL_FAMILY,
      "fake",
      "only:fake",
    ]);
    const fallbacks = tileRows(NAMES, columns, resolve, true);
    expect(fallbacks.some((t) => t.drawn.kind === "glyph")).toBe(false);
  });
});
