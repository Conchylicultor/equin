import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { exportedHookNames, readHookDrift } from "./read-hooks";
import { markerViolations, stripMarkers } from "./read-misuse-diagnostics";

const parse = (src: string) =>
  ts.createSourceFile("index.ts", src, ts.ScriptTarget.Latest);

describe("live:read-hooks", () => {
  test("reads the use* value exports, leaving types and other names out", () => {
    const src = [
      'export { useLive, mapRow } from "./a";',
      'export { useLiveReader, type useNotAValue } from "./b";',
      'export type { useTypeOnly } from "./c";',
    ].join("\n");
    expect(exportedHookNames(ts, parse(src))).toEqual([
      "useLive",
      "useLiveReader",
    ]);
  });

  test("a star export is refused: it hides which hooks it publishes", () => {
    expect(() => exportedHookNames(ts, parse('export * from "./a";'))).toThrow(
      /star export/,
    );
  });

  test("an unlisted hook and a stale entry are both drift", () => {
    expect(
      readHookDrift(["useLive", "useLiveRow"], {
        useLive: "read",
        useGone: "read",
      }),
    ).toEqual({ unlisted: ["useLiveRow"], stale: ["useGone"] });
    expect(readHookDrift(["useLive"], { useLive: "read" })).toEqual({
      unlisted: [],
      stale: [],
    });
  });
});

describe("live:read-misuse-diagnostics", () => {
  const SRC = [
    "useLive(c, {",
    "  // @ts-expect-error TS2353 — id with limit",
    "  limit: 5,",
    "});",
    "// @ts-expect-error TS2769 — a nullable count (both candidates)",
    "useLive(maybe, { count: true });",
    "// @ts-expect-error TS2322 TS2345 — two codes",
    "useLive(c, { id: 1 });",
  ].join("\n");
  const d = (line: number, code: number) => ({ line, code, message: "m" });

  test("parses each marker's codes and label, and blanks it keeping the line structure", () => {
    const { markers, stripped } = stripMarkers(SRC);
    expect(markers).toEqual([
      { line: 2, codes: [2353], label: "id with limit" },
      { line: 5, codes: [2769], label: "a nullable count (both candidates)" },
      { line: 7, codes: [2322, 2345], label: "two codes" },
    ]);
    expect(stripped).not.toContain("@ts-expect-error");
    expect(stripped.split("\n")).toHaveLength(SRC.split("\n").length);
  });

  test("a marker whose diagnostics are exactly its codes passes", () => {
    const { markers } = stripMarkers(SRC);
    expect(
      markerViolations(markers, [
        d(2, 2353),
        d(2, 2353),
        d(5, 2769),
        d(7, 2322),
        d(7, 2345),
      ]),
    ).toEqual([]);
  });

  test("a marker with no code, or a malformed one, is a violation", () => {
    for (const marker of [
      "// @ts-expect-error — no code",
      "// @ts-expect-error",
      "// @ts-expect-error 2322 — bare number",
      "// @ts-expect-error TS2322 no dash",
    ]) {
      const { markers } = stripMarkers([marker, "x;"].join("\n"));
      expect(markers[0]!.codes).toEqual([]);
      const bad = markerViolations(markers, [d(1, 2322)]);
      expect(bad).toHaveLength(1);
      expect(bad[0]).toMatch(/^1 — the marker names no TS code/);
    }
  });

  test("a listed code the line does not report is a violation", () => {
    const { markers } = stripMarkers(SRC);
    const bad = markerViolations(markers, [d(2, 2353), d(5, 2769), d(7, 2322)]);
    expect(bad).toEqual([
      "8 — the marker expects TS2345, but the line reports TS2322 (two codes)",
    ]);
  });

  test("a code on the line the marker does not list is a violation, TS2769 called out", () => {
    const { markers } = stripMarkers(SRC);
    const bad = markerViolations(markers, [
      d(2, 2353),
      d(2, 2769),
      d(5, 2769),
      d(5, 2322),
      d(7, 2322),
      d(7, 2345),
    ]);
    expect(bad).toHaveLength(2);
    expect(bad[0]).toMatch(/^3 — TS2769 "No overload matches this call"/);
    expect(bad[1]).toMatch(/^6 — TS2322, which the marker does not list/);
  });

  test("TS2769 in place of the listed code fails twice: the code is missing and 2769 is unlisted", () => {
    const { markers } = stripMarkers(SRC);
    const bad = markerViolations(markers, [
      d(2, 2769),
      d(5, 2769),
      d(7, 2322),
      d(7, 2345),
    ]);
    expect(bad).toHaveLength(2);
    expect(bad[0]).toMatch(/^3 — the marker expects TS2353/);
    expect(bad[1]).toMatch(/^3 — TS2769/);
  });

  test("an empty marked line and a diagnostic on an unmarked line are violations", () => {
    const { markers } = stripMarkers(SRC);
    const bad = markerViolations(markers, [
      d(5, 2769),
      d(7, 2322),
      d(7, 2345),
      d(0, 2345),
    ]);
    expect(bad).toHaveLength(2);
    expect(bad[0]).toMatch(/^3 — no diagnostic/);
    expect(bad[1]).toMatch(/^1 — TS2345 with no marker/);
  });
});
