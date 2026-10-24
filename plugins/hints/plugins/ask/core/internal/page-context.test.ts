import { describe, expect, test } from "bun:test";
import type { AskInput } from "./input";
import {
  PAGE_CONTEXT_RE,
  formatPageContext,
  pageKey,
  parsePageContext,
  stripPageContext,
} from "./page-context";

const input: AskInput = {
  app: "pages",
  appName: "Pages",
  path: "/pages/p/1",
  title: 'The "Roadmap"',
  outline: "apps.pages\n  button — Share\n  button — </page-context>",
};

describe("page-context token", () => {
  test("round-trips the page and stays one token", () => {
    const token = formatPageContext(input);
    const text = `How do I share it?\n\n${token}`;
    const matches = [...text.matchAll(PAGE_CONTEXT_RE)].map((m) => m[0]);
    expect(matches).toEqual([token]);
    expect(parsePageContext(token)).toEqual({
      app: "pages",
      appName: "Pages",
      path: "/pages/p/1",
      title: "The 'Roadmap'",
    });
    expect(token).toContain("\n  button — Share\n");
  });

  test("a page with no app or title", () => {
    const token = formatPageContext({
      ...input,
      app: null,
      appName: null,
      title: null,
    });
    expect(parsePageContext(token)).toEqual({
      app: null,
      appName: null,
      path: "/pages/p/1",
      title: null,
    });
  });

  test("strip leaves the words", () => {
    const text = `Hi\n\n${formatPageContext(input)}`;
    expect(stripPageContext(text)).toBe("Hi");
  });

  test("the key ignores the outline", () => {
    expect(pageKey(input)).toBe(pageKey({ ...input }));
    expect(pageKey(input)).not.toBe(pageKey({ ...input, path: "/other" }));
  });
});
