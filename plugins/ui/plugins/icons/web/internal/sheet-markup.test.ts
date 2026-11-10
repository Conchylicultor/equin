import { describe, expect, test } from "bun:test";
import { splitSheetMarkup } from "./sheet-markup";

describe("splitSheetMarkup", () => {
  test("a sheet with no resources keeps its markup whole", () => {
    const markup = `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="a"><path d="M0 0"/></symbol></svg>`;
    expect(splitSheetMarkup(markup)).toEqual({
      symbols: markup,
      resources: new Map(),
    });
  });

  test("resources leave their symbol, filed under its id, ids and references unchanged", () => {
    const mask = `<mask id="a-k" maskUnits="userSpaceOnUse"><rect fill="white"/><path d="M1 1" stroke="black"/></mask>`;
    const gradient = `<linearGradient id="g"/>`;
    const other = `<mask id="b-k"><rect/></mask>`;
    const markup = `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="a" viewBox="0 0 24 24">${mask}<g mask="url(#a-k)"><circle r="8"/></g>${gradient}</symbol><symbol id="c"><path d="M0 0"/></symbol><symbol id="b">${other}<g mask="url(#b-k)"/></symbol></svg>`;
    expect(splitSheetMarkup(markup)).toEqual({
      symbols: `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="a" viewBox="0 0 24 24"><g mask="url(#a-k)"><circle r="8"/></g></symbol><symbol id="c"><path d="M0 0"/></symbol><symbol id="b"><g mask="url(#b-k)"/></symbol></svg>`,
      resources: new Map([
        ["a", `${mask}${gradient}`],
        ["b", other],
      ]),
    });
  });

  test("an element whose name only starts like a resource's stays", () => {
    const markup = `<svg><symbol id="a"><maskish/><g mask="url(#m)"/></symbol></svg>`;
    expect(splitSheetMarkup(markup).resources.size).toBe(0);
  });

  test("a resource outside every symbol throws: no symbol would render it", () => {
    const markup = `<svg><mask id="m"/><symbol id="a"><g mask="url(#m)"/></symbol></svg>`;
    expect(() => splitSheetMarkup(markup)).toThrow(/outside every symbol/);
  });
});
