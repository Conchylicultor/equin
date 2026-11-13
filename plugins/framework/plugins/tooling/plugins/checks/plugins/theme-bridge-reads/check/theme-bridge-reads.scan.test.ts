import { expect, test } from "bun:test";
import { themeBridgeFold } from "./theme-bridge-reads.scan";

test("a CSS read's line counts the lines of a comment before it", () => {
  const css = [
    "@theme inline {",
    "  --color-x: var(--x);",
    "}",
    "/* a comment",
    "   over two lines */",
    ".a { color: var(--color-x); }",
  ].join("\n");
  expect(themeBridgeFold.scan(css, "p/web/a.css", null)).toEqual({
    bridges: [["--color-x", "--x"]],
    cssReads: [{ rel: "p/web/a.css", line: 6, name: "--color-x" }],
    codeReads: [],
  });
});
