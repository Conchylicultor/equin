import { describe, expect, test } from "bun:test";
import {
  linePositionText,
  waitersAhead,
  waitLineOf,
  type LineOp,
} from "./wait-line";

const at = (s: number): string =>
  new Date(1_800_000_000_000 + s * 1000).toISOString();
const op = (
  kind: LineOp["kind"],
  wait: NonNullable<LineOp["openWait"]>["kind"] | null,
  startedS: number,
  lane: LineOp["lane"] = "background",
): LineOp => ({
  kind,
  lane,
  openWait: wait ? { kind: wait, startedAt: at(startedS) } : null,
});

describe("waitersAhead", () => {
  test("counts the ops of the same line that started waiting earlier", () => {
    const a = op("build", "host-grant", 1);
    const b = op("check", "host-grant", 2);
    const c = op("test", "host-grant", 3);
    const all = [c, a, b];
    expect(waitersAhead(a, all)).toBe(0);
    expect(waitersAhead(b, all)).toBe(1);
    expect(waitersAhead(c, all)).toBe(2);
  });

  test("other lines do not count: another lane, the e2e pool, another wait", () => {
    const me = op("build", "host-grant", 10);
    const all = [
      me,
      op("build", "host-grant", 1, "interactive"),
      op("e2e", "host-grant", 2),
      op("push", "push-mutex", 3),
      op("build", null, 4),
    ];
    expect(waitersAhead(me, all)).toBe(0);
  });

  test("a wait that is no first-come line has no position", () => {
    expect(waitersAhead(op("build", "build-lock", 1), [])).toBeNull();
    expect(waitersAhead(op("check", "in-flight", 1), [])).toBeNull();
    expect(waitersAhead(op("build", null, 1), [])).toBeNull();
    expect(waitLineOf(op("push", "push-mutex", 1))).toBe("push-mutex");
  });
});

describe("linePositionText", () => {
  test("reads as a place in line", () => {
    expect(linePositionText(null)).toBe("");
    expect(linePositionText(0)).toBe(" · next in line");
    expect(linePositionText(1)).toBe(" · 2nd in line");
    expect(linePositionText(2)).toBe(" · 3rd in line");
    expect(linePositionText(3)).toBe(" · 4th in line");
    expect(linePositionText(10)).toBe(" · 11th in line");
    expect(linePositionText(20)).toBe(" · 21st in line");
  });
});
