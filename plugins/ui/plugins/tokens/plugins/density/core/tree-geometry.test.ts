import { describe, expect, it } from "bun:test";
import { densityGroup } from "./group";

/**
 * The default tree geometry, resolved from the density defaults the way the
 * browser would: `var()` substituted from the group's own defaults, `calc()`
 * evaluated, `rem` at 16px. The defaults promise a relation, not a number —
 * the indent is one chevron box plus the row's cell gap (so a child's chevron
 * starts under its parent's icon, which the column disclosure lays after the
 * chevron box and that gap), and a guide sits at half the chevron box (under
 * its parent's chevron).
 */

const ROOT_FONT_PX = 16;

const byVar = new Map<string, string>(
  (
    Object.keys(densityGroup.schema) as (keyof typeof densityGroup.schema)[]
  ).map((key) => [densityGroup.vars[key], densityGroup.schema[key].default]),
);

function substitute(value: string, depth = 0): string {
  if (depth > 10) throw new Error(`var() cycle resolving ${value}`);
  const next = value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const v = byVar.get(name);
    if (v === undefined) throw new Error(`no density default for ${name}`);
    return `(${v})`;
  });
  return next === value ? value : substitute(next, depth + 1);
}

/** A px length from `+ - * /` over lengths (px, rem) and plain numbers. */
function evaluate(expr: string): number {
  const tokens =
    expr.replace(/calc\(/g, "(").match(/\d*\.?\d+(?:px|rem)?|[()+\-*/]/g) ?? [];
  let i = 0;
  const atom = (): number => {
    const t = tokens[i++];
    if (t === undefined) throw new Error(`unexpected end of ${expr}`);
    if (t === "(") {
      const v = sum();
      if (tokens[i++] !== ")") throw new Error(`unbalanced ${expr}`);
      return v;
    }
    if (t === "-") return -atom();
    const n = parseFloat(t);
    if (Number.isNaN(n)) throw new Error(`bad token ${t} in ${expr}`);
    return t.endsWith("rem") ? n * ROOT_FONT_PX : n;
  };
  const product = (): number => {
    let v = atom();
    while (tokens[i] === "*" || tokens[i] === "/") {
      const op = tokens[i++];
      const r = atom();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (tokens[i] === "+" || tokens[i] === "-") {
      const op = tokens[i++];
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  if (i !== tokens.length) throw new Error(`trailing tokens in ${expr}`);
  return v;
}

const px = (key: keyof typeof densityGroup.schema) =>
  evaluate(substitute(densityGroup.schema[key].default));

describe("density: default tree geometry", () => {
  it("the chevron box is the 20px box the row always drew", () => {
    expect(px("treeChevronW")).toBe(20);
  });

  it("one indent step = the chevron box + the row's cell gap", () => {
    expect(px("treeIndent")).toBe(px("treeChevronW") + px("treeRowGap"));
    expect(px("treeIndent")).toBe(24);
  });

  it("a guide sits at half the chevron box — under the parent's chevron", () => {
    expect(px("treeGuideX")).toBe(px("treeChevronW") / 2);
    expect(px("treeGuideX")).toBe(10);
  });

  it("a child's chevron starts where its parent's icon does", () => {
    // Parent at depth d: chevron box at 0, icon after the box and the gap.
    const parentIconStart = px("treeChevronW") + px("treeRowGap");
    // Child at depth d+1: its chevron box one indent step in.
    const childChevronStart = px("treeIndent");
    expect(childChevronStart).toBe(parentIconStart);
  });
});
