import { describe, expect, test } from "bun:test";
import { inlineBoundary } from "@plugins/ids/core";
import { PROTOTYPES_DIR_DISPLAY } from "@plugins/infra/plugins/paths/plugins/display/core";
import { protoIdKind, prototypeIdsIn } from "./id";

// The pin that keeps the mint and the readers of the format together. Every
// consumer — the folder-name problem in `validate.ts`, the active-data chip's
// inline reading, `prototypeIdsIn` — derives from `protoIdKind`, so a mint that
// stops satisfying them fails HERE instead of silently switching the chips off.
// Every current-shape fixture is a REAL mint.

const inline = (text: string): string[] =>
  [...text.matchAll(inlineBoundary(protoIdKind.pattern))].map((m) => m[0]);

describe("protoIdKind.mint", () => {
  test("every minted id is a valid folder name", () => {
    for (let i = 0; i < 500; i++) {
      expect(protoIdKind.is(protoIdKind.mint())).toBe(true);
    }
  });

  test("mints the documented shape", () => {
    for (let i = 0; i < 500; i++) {
      const [prefix, epoch, suffix] = protoIdKind.mint().split("-");
      expect(prefix).toBe("proto");
      expect(Number(epoch)).toBeGreaterThan(1_700_000_000);
      expect(suffix).toHaveLength(6);
    }
  });

  test("ids are distinct within one second", () => {
    const ids = new Set(Array.from({ length: 200 }, () => protoIdKind.mint()));
    // A collision is handled by re-minting in `machine/internal/mint.ts`, not prevented
    // here; assert only that the mint is random at all.
    expect(ids.size).toBeGreaterThan(195);
  });
});

describe("protoIdKind.is", () => {
  test("rejects the hand-made folder names it exists to catch", () => {
    for (const name of [
      "ember",
      "improve-quiet",
      "control-panel-studies",
      "_template",
      "_history",
      "proto",
      "proto-",
      "proto-abc-1234",
      "proto-1787215770-3i6",
      "proto-1787215770-3I6V",
      "x-proto-1787215770-3i6v",
      "proto-1787215770-3i6v/index.html",
      " proto-1787215770-3i6v",
    ]) {
      expect(protoIdKind.is(name)).toBe(false);
    }
  });

  test("accepts the folders minted before the 6-char suffix", () => {
    expect(protoIdKind.is("proto-1787215770-3i6v")).toBe(true);
  });
});

describe("inline recognition (the chip's reading)", () => {
  test("a real mint in prose, every one, in order", () => {
    const a = protoIdKind.mint();
    const b = protoIdKind.mint();
    expect(inline(`${a}, then ${b}.`)).toEqual([a, b]);
  });

  test("a path or dotted context is not a mention", () => {
    const id = protoIdKind.mint();
    expect(inline(`/${id}`)).toEqual([]);
    expect(inline(`${PROTOTYPES_DIR_DISPLAY}/${id}/index.html`)).toEqual([]);
    expect(inline(`${id}.ts`)).toEqual([]);
  });

  test("`proto-` with no id after it is not a match", () => {
    expect(inline("the proto- prefix alone")).toEqual([]);
    expect(inline("proto-typing is not an id")).toEqual([]);
    expect(inline("proto-1786877040")).toEqual([]);
  });
});

describe("prototypeIdsIn", () => {
  test("finds ids inside paths too, deduped, first mention first", () => {
    const a = protoIdKind.mint();
    const b = protoIdKind.mint();
    expect(
      prototypeIdsIn({ cmd: `cat ~/x/${a}/index.html && echo ${b} ${a}` }),
    ).toEqual([a, b]);
  });
});
