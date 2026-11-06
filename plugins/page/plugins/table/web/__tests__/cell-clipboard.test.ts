import { describe, expect, test } from "vitest";
import type { RichText } from "@plugins/page/plugins/editor/core";
import {
  CELLS_MIME,
  htmlTableCells,
  isCellGrid,
  readCells,
  writeCells,
} from "../internal/cell-clipboard";

/** The part of a DataTransfer the codec uses — jsdom has none. */
function transfer(init: Record<string, string> = {}): DataTransfer {
  const data = new Map(Object.entries(init));
  const dt = {
    getData: (type: string) => data.get(type) ?? "",
    setData: (type: string, value: string) => void data.set(type, value),
  };
  return dt as unknown as DataTransfer;
}

const r = (s: string): RichText => (s ? [{ text: s }] : []);

describe("cell clipboard", () => {
  const cells: RichText[][] = [
    [
      [{ text: "bold", marks: ["bold"] }],
      [{ text: "site", link: "https://x.y" }],
    ],
    [r("two\nlines"), r("<tag> & co")],
  ];

  test("our own flavour round-trips the runs exactly", () => {
    const dt = transfer();
    writeCells(dt, cells);
    expect(readCells(dt)).toEqual({ cells, source: "cells" });
  });

  test("the HTML flavour reads back marks, links and line breaks", () => {
    const dt = transfer();
    writeCells(dt, cells);
    expect(htmlTableCells(dt.getData("text/html"))).toEqual(cells);
  });

  test("a spreadsheet's table: whitespace collapsed, spans padded, ragged rows squared", () => {
    const html = `<google-sheets-html-origin><table>
      <tr><td colspan="2"> merged </td><td>c</td></tr>
      <tr><td><p>one</p><p>two</p></td></tr>
    </table></google-sheets-html-origin>`;
    const dt = transfer({ "text/html": html, "text/plain": "ignored" });
    expect(readCells(dt)).toEqual({
      cells: [
        [r("merged"), [], r("c")],
        [r("one\ntwo"), [], []],
      ],
      source: "html",
    });
  });

  test("HTML without a table falls back to the plain text", () => {
    const dt = transfer({ "text/html": "<p>hi</p>", "text/plain": "a\tb" });
    expect(readCells(dt)).toEqual({
      cells: [[r("a"), r("b")]],
      source: "text",
    });
  });

  test("an empty clipboard holds no cells", () => {
    expect(readCells(transfer())).toBeNull();
  });

  test("a malformed payload of our own is loud", () => {
    expect(() =>
      readCells(transfer({ [CELLS_MIME]: '{"cells":1}' })),
    ).toThrow();
  });

  test("text spreads across cells only when it has a tab", () => {
    const lines = transfer({ "text/plain": "one\ntwo" });
    expect(isCellGrid(readCells(lines)!, lines)).toBe(false);
    const tsv = transfer({ "text/plain": "a\tb" });
    expect(isCellGrid(readCells(tsv)!, tsv)).toBe(true);
    const one = transfer({
      [CELLS_MIME]: JSON.stringify({ cells: [[r("x")]] }),
    });
    expect(isCellGrid(readCells(one)!, one)).toBe(false);
  });
});
