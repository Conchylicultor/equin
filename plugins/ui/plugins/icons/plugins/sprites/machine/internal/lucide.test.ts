import { describe, expect, it } from "bun:test";
import { LUCIDE_MAP, lucideNameOf } from "@plugins/ui/plugins/icons/core";
import { resolveIcon } from "@plugins/ui/plugins/icons/server";
import { tuneLucideBody } from "./lucide";
import { PACKAGE, readSet } from "./symbol-sets";

describe("tuneLucideBody", () => {
  it("scales the glyph to 7/8 of its box about the centre, with a 1.2px non-scaling stroke", () => {
    expect(
      tuneLucideBody({
        body: '<g fill="none" stroke="currentColor" stroke-width="2"><path d="m21 21l-4.34-4.34"/><circle cx="11" cy="11" r="8"/></g>',
        width: 24,
        height: 24,
      }),
    ).toEqual({
      body:
        '<g transform="translate(1.5 1.5) scale(0.875)" stroke-width="1.2">' +
        '<g fill="none" stroke="currentColor" stroke-width="1.2">' +
        '<path d="m21 21l-4.34-4.34" vector-effect="non-scaling-stroke"/>' +
        '<circle cx="11" cy="11" r="8" vector-effect="non-scaling-stroke"/>' +
        "</g></g>",
      width: 24,
      height: 24,
    });
  });

  it("throws on a stroke width or an element Lucide does not use", () => {
    expect(() =>
      tuneLucideBody({
        body: '<path stroke-width="3" d="M0 0"/>',
        width: 24,
        height: 24,
      }),
    ).toThrow(/stroke-width="3"/);
    expect(() =>
      tuneLucideBody({ body: "<text>a</text>", width: 24, height: 24 }),
    ).toThrow(/unexpected <text>/);
  });
});

describe("the Lucide map against the installed set", () => {
  it("resolves and tunes every mapped icon", async () => {
    const set = await readSet(PACKAGE.lucide);
    for (const name of Object.keys(LUCIDE_MAP)) {
      const lucide = lucideNameOf(name);
      if (lucide === undefined) continue;
      const tuned = tuneLucideBody(resolveIcon(set, lucide));
      expect(tuned.width).toBe(24);
      expect(tuned.body).toContain("non-scaling-stroke");
    }
  });
});
