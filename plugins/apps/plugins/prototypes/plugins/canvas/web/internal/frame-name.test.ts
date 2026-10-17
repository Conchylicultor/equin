import { describe, expect, it } from "bun:test";
import type { PrototypeOption } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { frameName, letterOf, type NamedFrame } from "./frame-name";

const opt = (
  name: string,
  values: [string, string, ...string[]],
): PrototypeOption => ({
  kind: "choice",
  name,
  values,
  default: values[0],
  group: null,
});

const options = [
  opt("design", ["mist", "slate"]),
  opt("screen", ["home", "task"]),
  opt("lead", ["status", "avatar"]),
  opt("tabs", ["underline", "pill"]),
];

const frame = (id: number, picks: Record<string, string>): NamedFrame => ({
  id,
  options,
  picks,
});

describe("frameName", () => {
  it("names a lone frame by its first two options", () => {
    const a = frame(1, { lead: "avatar" });
    expect(frameName(a, [a])).toEqual(["Mist", "Home"]);
  });

  it("adds every option on which the frames differ", () => {
    const a = frame(1, {});
    const b = frame(2, { lead: "avatar" });
    expect(frameName(a, [a, b])).toEqual(["Mist", "Home", "Status"]);
    expect(frameName(b, [a, b])).toEqual(["Mist", "Home", "Avatar"]);
  });

  it("is empty for a prototype with no options", () => {
    const f: NamedFrame = { id: 1, options: [], picks: {} };
    expect(frameName(f, [f])).toEqual([]);
  });
});

describe("letterOf", () => {
  it("letters frames in canvas order", () => {
    expect([0, 1, 2].map(letterOf)).toEqual(["A", "B", "C"]);
  });
});
