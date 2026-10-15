import { expect, test } from "bun:test";
import { parseNear } from "./search-place";

test("--near parses lat,lng and refuses anything else", () => {
  expect(parseNear("48.8566, 2.3522")).toEqual({ lat: 48.8566, lng: 2.3522 });
  expect(parseNear("-33.9,151")).toEqual({ lat: -33.9, lng: 151 });
  expect(() => parseNear("Paris")).toThrow(/--near/);
  expect(() => parseNear("91,0")).toThrow(/--near/);
});
