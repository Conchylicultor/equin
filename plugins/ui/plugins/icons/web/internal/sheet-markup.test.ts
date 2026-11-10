import { describe, expect, test } from "bun:test";
import { splitSheetMarkup } from "./sheet-markup";

describe("splitSheetMarkup", () => {
  test("a sheet with no resources keeps its markup whole", () => {
    const markup = `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="a"><path d="M0 0"/></symbol></svg>`;
    expect(splitSheetMarkup(markup)).toEqual({
      symbols: markup,
      resources: null,
    });
  });

  test("masks leave their symbol for the resources sheet, ids and references unchanged", () => {
    const mask = `<mask id="a-k" maskUnits="userSpaceOnUse"><rect fill="white"/><path d="M1 1" stroke="black"/></mask>`;
    const gradient = `<linearGradient id="g"/>`;
    const markup = `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="a">${mask}<g mask="url(#a-k)"><circle r="8"/></g>${gradient}</symbol></svg>`;
    expect(splitSheetMarkup(markup)).toEqual({
      symbols: `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="a"><g mask="url(#a-k)"><circle r="8"/></g></symbol></svg>`,
      resources: `<svg xmlns="http://www.w3.org/2000/svg">${mask}${gradient}</svg>`,
    });
  });

  test("an element whose name only starts like a resource's stays", () => {
    const markup = `<svg><symbol id="a"><maskish/><g mask="url(#m)"/></symbol></svg>`;
    expect(splitSheetMarkup(markup).resources).toBeNull();
  });
});
