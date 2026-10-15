import { expect, test } from "bun:test";
import { parseCsv } from "./csv";

test("parses quoted fields with commas, escaped quotes and multi-line values", () => {
  const text = [
    "date,name,userComment",
    '"2026-03-14T12:41:17.986Z","CHEZ POM’","Cafe/Restaurant Bio ',
    'Comedy club 1er mercredi"',
    '"2026-03-12T09:24:04.888Z","Bar ""Nouveau"", Marais",""',
    "",
  ].join("\n");
  expect(parseCsv(text)).toEqual([
    ["date", "name", "userComment"],
    [
      "2026-03-14T12:41:17.986Z",
      "CHEZ POM’",
      "Cafe/Restaurant Bio \nComedy club 1er mercredi",
    ],
    ["2026-03-12T09:24:04.888Z", 'Bar "Nouveau", Marais', ""],
  ]);
});

test("handles CRLF, a BOM, unquoted fields and a missing final newline", () => {
  expect(parseCsv('﻿a,b\r\n1,"x\r\ny"\r\n2,')).toEqual([
    ["a", "b"],
    ["1", "x\r\ny"],
    ["2", ""],
  ]);
});

test("an unterminated quote throws", () => {
  expect(() => parseCsv('a\n"open')).toThrow(/quoted field/);
});
