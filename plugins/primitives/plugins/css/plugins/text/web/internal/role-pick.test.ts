import { describe, expect, it } from "bun:test";

import { PICK_EMPHASES, PICK_FAMILIES, PICK_RUNGS } from "../../core";
import { rolePickClass, rolePickScope } from "./role-pick";

describe("rolePickClass", () => {
  it("starts with the fallback rung, then a query per rung of the picker", () => {
    for (const fallback of PICK_RUNGS) {
      const classes = rolePickClass(fallback).split(" ");
      expect(classes[0]).toBe(
        fallback === "tag" ? "text-tag" : `text-${fallback}`,
      );
      for (const rung of PICK_RUNGS) {
        expect(classes).toContain(
          `[@container_style(--role-pick:${rung})]:text-${rung}`,
        );
      }
    }
  });

  it("swaps every role rung for its compact form, and keeps the sub-scale", () => {
    const classes = rolePickClass("label", true).split(" ");
    expect(classes[0]).toBe("text-label-compact");
    // `ambient` (the default step) compacts; `base` draws the rung named.
    expect(classes).toContain(
      "[@container_style(--role-pick:caption)_and_style(--role-step:ambient)]:text-caption-compact",
    );
    expect(classes).toContain(
      "[@container_style(--role-pick:caption)_and_style(--role-step:base)]:text-caption",
    );
    expect(classes).toContain("[@container_style(--role-pick:3xs)]:text-3xs");
  });

  it("covers every emphasis but `role` and every family but `role`", () => {
    const classes = rolePickClass("caption");
    for (const emphasis of PICK_EMPHASES.filter((e) => e !== "role"))
      expect(classes).toContain(`style(--role-emphasis:${emphasis})`);
    for (const family of PICK_FAMILIES.filter((f) => f !== "role"))
      expect(classes).toContain(`style(--role-family:${family})`);
  });
});

describe("rolePickScope", () => {
  it("copies the part's three tokens into the generic vars", () => {
    expect(
      rolePickScope({
        role: "--card-title-role",
        emphasis: "--card-title-emphasis",
        family: "--card-title-family",
        fallback: "label",
      }),
    ).toEqual({
      "--role-pick": "var(--card-title-role)",
      "--role-emphasis": "var(--card-title-emphasis)",
      "--role-family": "var(--card-title-family)",
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
