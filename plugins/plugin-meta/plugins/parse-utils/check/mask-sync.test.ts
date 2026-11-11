import { expect, test } from "bun:test";
import ts from "typescript";
import { maskSource } from "../core/mask-source";
import { maskDivergence } from "./mask-sync";

function divergence(rel: string, src: string, masked = maskSource(src)) {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
  return maskDivergence(ts, sf, src, masked);
}

test("a file the masker reads in sync has no divergence", () => {
  const src = [
    "const re = /a'b/g;",
    `const t = \`x \${y.map((z) => \`\${z}'\`)} w\`;`,
    `type K = \`\${A}-\${B}\`;`,
    "export const C = () => <p title=\"it's\">Couldn't {n} load</p>;",
    "const half = vw! / 2;",
  ].join("\n");
  expect(divergence("a.tsx", src)).toBeNull();
});

test("an identifier the mask blanked is code read as a literal", () => {
  const src = "const a = 'x';\nexport const b = 1;\n";
  // A mask out of sync from the first quote on.
  const masked = "const a = '            \n                   \n";
  expect(divergence("a.ts", src, masked)).toEqual({
    line: 2,
    column: 14,
    kind: "code-masked",
    text: "b",
  });
});

test("a literal the mask left visible is a literal read as code", () => {
  const src = "const a = 'x';\n";
  expect(divergence("a.ts", src, src)).toMatchObject({
    line: 1,
    column: 11,
    kind: "literal-exposed",
  });
});

test("JSX text the mask left visible is a literal read as code", () => {
  const src = "const a = <p>hi</p>;\n";
  expect(divergence("a.tsx", src, src)).toMatchObject({
    kind: "literal-exposed",
    text: "hi",
  });
});
