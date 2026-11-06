import { describe, expect, test } from "bun:test";
import type { RichText } from "@plugins/page/plugins/editor/core";
import { cellsToTsv, tsvToCells } from "./cell-clipboard";

const r = (s: string): RichText => (s ? [{ text: s }] : []);
const texts = (cells: RichText[][]): string[][] =>
  cells.map((row) => row.map((c) => c.map((x) => x.text).join("")));

describe("tab-separated values", () => {
  test("rows by line, cells by tab; a final line break ends the last row", () => {
    expect(texts(tsvToCells("a\tb\r\nc\td\n"))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("empty cells keep their place", () => {
    expect(texts(tsvToCells("\tb\n\t"))).toEqual([
      ["", "b"],
      ["", ""],
    ]);
  });

  test("a quoted field holds tabs, line breaks and doubled quotes", () => {
    expect(texts(tsvToCells('"x\ty"\t"one\ntwo"\t"say ""hi"""'))).toEqual([
      ["x\ty", "one\ntwo", 'say "hi"'],
    ]);
  });

  test("an unclosed quote is a literal quote", () => {
    expect(texts(tsvToCells('"open\tb'))).toEqual([['"open', "b"]]);
  });

  test("writing quotes exactly the fields that need it, and reads back", () => {
    const cells = [
      [r("plain"), r("tab\there"), r("")],
      [r("two\nlines"), r('a "quote"'), r("**md**")],
    ];
    const tsv = cellsToTsv(cells);
    expect(tsv).toBe(
      'plain\t"tab\there"\t\n"two\nlines"\t"a ""quote"""\t**md**',
    );
    expect(tsvToCells(tsv)).toEqual(cells);
  });

  test("a cell's marks are not written to plain text", () => {
    expect(cellsToTsv([[[{ text: "b", marks: ["bold"] }]]])).toBe("b");
  });
});
