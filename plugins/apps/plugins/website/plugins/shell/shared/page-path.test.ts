import { describe, expect, test } from "bun:test";
import { pathShowsPage } from "./page-path";

describe("pathShowsPage", () => {
  test("the page and its keyed and nested suffixes", () => {
    expect(pathShowsPage("/about/vision", "/about/vision")).toBe(true);
    expect(pathShowsPage("/about/vision;x=1", "/about/vision")).toBe(true);
    expect(pathShowsPage("/about/vision/more", "/about/vision")).toBe(true);
  });
  test("another page, or a page whose name it starts", () => {
    expect(pathShowsPage("/about", "/about/vision")).toBe(false);
    expect(pathShowsPage("/about/story", "/about/vision")).toBe(false);
    expect(pathShowsPage("/about/visionary", "/about/vision")).toBe(false);
  });
});
