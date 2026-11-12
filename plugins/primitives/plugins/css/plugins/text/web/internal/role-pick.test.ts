import { describe, expect, it } from "bun:test";
import { PICK_RUNGS } from "../../core";
import { rolePickClass, rolePickScope } from "./role-pick";

describe("rolePickClass", () => {
  it("is the fallback rung, then the one picker class", () => {
    for (const fallback of PICK_RUNGS) {
      const classes = rolePickClass(fallback).split(" ");
      expect(classes[0]).toBe(`text-${fallback}`);
      expect(classes.at(-1)).toBe("role-pick");
    }
  });

  it("uses the compact fallback and picker class in a compact region", () => {
    expect(rolePickClass("label", true)).toBe(
      "text-label-compact role-pick-compact",
    );
    expect(rolePickClass("2xs", true)).toBe("text-2xs role-pick-compact");
  });

  it("never emits a per-element style query", () => {
    for (const fallback of PICK_RUNGS)
      for (const compact of [false, true])
        expect(rolePickClass(fallback, compact)).not.toContain("@container");
  });
});

describe("rolePickScope", () => {
  it("copies the part's tokens into the generic vars, the fallback folded in", () => {
    expect(
      rolePickScope({
        role: "--card-title-role",
        emphasis: "--card-title-emphasis",
        family: "--card-title-family",
        fallback: "label",
      }),
    ).toEqual({
      "--role-pick": "var(--card-title-role, label)",
      "--role-emphasis": "var(--card-title-emphasis, role)",
      "--role-family": "var(--card-title-family, role)",
      "--role-step": "ambient",
    } as never);
  });

  it("copies the part's step token, defaulting to ambient", () => {
    expect(
      rolePickScope({
        role: "--a-role",
        emphasis: "--a-emphasis",
        family: "--a-family",
        step: "--pick-step",
        fallback: "label",
      }),
    ).toMatchObject({ "--role-step": "var(--pick-step, ambient)" });
  });
});
