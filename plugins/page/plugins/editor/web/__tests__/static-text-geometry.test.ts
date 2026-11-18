import { describe, expect, it } from "vitest";
import {
  EMPTY_LINE_ATTR,
  staticDomRange,
  staticOffsetOfDomPoint,
  staticTextLength,
} from "../internal/static-text-geometry";
import { TOKEN_LENGTH_ATTR } from "../components/runs-renderer";

// The DOM a dormant line renders for runs `ab` + **cd** + a 10-character
// token drawn as a 3-letter chip + `e` + soft break + `fg`.
function line(): HTMLParagraphElement {
  const p = document.createElement("p");
  p.innerHTML =
    `ab<strong>cd</strong><span ${TOKEN_LENGTH_ATTR}="10"><b>chp</b></span>` +
    `e<br>fg`;
  return p;
}

describe("static text geometry", () => {
  it("counts a token as its spelling and a soft break as one", () => {
    expect(staticTextLength(line())).toBe(2 + 2 + 10 + 1 + 1 + 2);
  });

  it("an empty line's placeholder break holds no character", () => {
    const p = document.createElement("p");
    p.innerHTML = `<br ${EMPTY_LINE_ATTR}="">`;
    expect(staticTextLength(p)).toBe(0);
  });

  it("maps DOM points to linear offsets", () => {
    const p = line();
    const bold = p.querySelector("strong")!.firstChild!;
    expect(staticOffsetOfDomPoint(p, p.firstChild!, 1)).toBe(1);
    expect(staticOffsetOfDomPoint(p, bold, 2)).toBe(4);
    const chip = p.querySelector("b")!.firstChild!;
    expect(staticOffsetOfDomPoint(p, chip, 2)).toBe(4);
    expect(staticOffsetOfDomPoint(p, chip, 2, true)).toBe(14);
    const fg = p.lastChild!;
    expect(staticOffsetOfDomPoint(p, fg, 1)).toBe(17);
    expect(staticOffsetOfDomPoint(p, p, p.childNodes.length)).toBe(18);
    expect(staticOffsetOfDomPoint(p, document.body, 0)).toBeNull();
  });

  it("builds ranges that round-trip through the point read", () => {
    const p = line();
    for (const [from, to] of [
      [0, 18],
      [1, 3],
      [4, 14],
      [14, 15],
      [16, 17],
    ] as const) {
      const r = staticDomRange(p, from, to);
      expect(staticOffsetOfDomPoint(p, r.startContainer, r.startOffset)).toBe(
        from,
      );
      expect(staticOffsetOfDomPoint(p, r.endContainer, r.endOffset)).toBe(to);
    }
  });

  it("clamps out-of-range offsets into the text", () => {
    const r = staticDomRange(line(), -5, 99);
    expect(r.toString()).toBe("abcdchpe" + "fg");
  });
});
