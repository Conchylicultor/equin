import { describe, expect, test } from "bun:test";
import { tildifyText } from "@plugins/infra/plugins/host-account/core";
import { toRelativePath } from "./shown-path";

describe("file chip path", () => {
  test("inside the checkout stays relative", () => {
    expect(toRelativePath("/w/att-1/src/a.ts", "att-1")).toBe("src/a.ts");
  });

  test("outside the checkout: only the home dir becomes ~", () => {
    const p = toRelativePath("/h/me/Downloads/a.mp4", "att-1");
    expect(p).toBe("/h/me/Downloads/a.mp4");
    expect(tildifyText(p, "/h/me")).toBe("~/Downloads/a.mp4");
    expect(tildifyText("/h/mey/a.mp4", "/h/me")).toBe("/h/mey/a.mp4");
  });
});
