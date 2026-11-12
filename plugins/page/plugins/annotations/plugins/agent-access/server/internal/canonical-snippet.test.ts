import { describe, expect, test } from "bun:test";
import { canonicalSnippet } from "./canonical-snippet";

/** Stand-ins for the server's protected spans (an id, a page link): emitted verbatim. */
const ids = [/\btask-\d+-[a-z0-9]+\b/g, /\[\[page:[^\]]+\]\]/g];

describe("canonicalSnippet", () => {
  test("escapes a literal delimiter the way read_page does", () => {
    expect(canonicalSnippet("stripped ~20 renderers", ids)).toBe(
      "stripped \\~20 renderers",
    );
    expect(canonicalSnippet("set GOOGLE_MAPS_KEY there", ids)).toBe(
      "set GOOGLE\\_MAPS\\_KEY there",
    );
  });

  test("is the identity on text read_page emitted", () => {
    const read = [
      "  ### D28. Keep working? (measured 2026-11-12)",
      "    * **Numbers** (\\~3× slower): 9.3 s",
      "    - [ ] task-1794147909-ax6jyb: **keyboard shortcuts**",
      "      1. *first* and `code`",
      "> quoted [[page:block-1]]",
    ].join("\n");
    expect(canonicalSnippet(read, ids)).toBe(read);
  });

  test("keeps the block prefix and only re-spells the inline text", () => {
    expect(canonicalSnippet("    * **Numbers** (~3× slower)", ids)).toBe(
      "    * **Numbers** (\\~3× slower)",
    );
    expect(canonicalSnippet("- [x] done ~now", ids)).toBe("- [x] done \\~now");
  });

  test("splits a mark around a protected span", () => {
    const written = "* **Session 2 (task-1794187349-sc1cxj).** Files";
    const canonical = canonicalSnippet(written, ids);
    expect(canonical).not.toBe(written);
    expect(canonical).toContain("task-1794187349-sc1cxj");
    // A fixed point: the read's spelling spells itself.
    expect(canonicalSnippet(canonical, ids)).toBe(canonical);
  });

  test("leaves tag lines and fenced bodies verbatim", () => {
    const text = [
      '<agent-inline id="block-1">',
      "```ts",
      "const a_b = x ~ y;",
      "```",
      "</agent-inline>",
    ].join("\n");
    expect(canonicalSnippet(text, ids)).toBe(text);
  });
});
