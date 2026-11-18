import { describe, expect, test } from "bun:test";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { convergenceBuild } from "./plan";

describe("convergenceBuild", () => {
  test("main and two compositions due at one head: one build, three targets", () => {
    const build = convergenceBuild({
      main: true,
      compositions: ["sonata", "website"],
      head: "c4",
      mainServed: true,
    });
    expect(build).toEqual({
      targets: [MAIN_COMPOSITION_ID, "sonata", "website"],
      compositionArgs: [
        "--composition",
        MAIN_COMPOSITION_ID,
        "sonata",
        "website",
      ],
      key: `c4 ${MAIN_COMPOSITION_ID},sonata,website`,
      skipChecks: false,
    });
  });

  test("main alone is a plain build", () => {
    expect(
      convergenceBuild({
        main: true,
        compositions: [],
        head: "c4",
        mainServed: true,
      }),
    ).toEqual({
      targets: [MAIN_COMPOSITION_ID],
      compositionArgs: [],
      key: `c4 ${MAIN_COMPOSITION_ID}`,
      skipChecks: false,
    });
  });

  test("main's first deploy (nothing served) skips the full check pass", () => {
    const first = convergenceBuild({
      main: true,
      compositions: [],
      head: "c4",
      mainServed: false,
    });
    expect(first?.skipChecks).toBe(true);
    expect(first?.key).toBe(`c4 ${MAIN_COMPOSITION_ID}`);
  });

  test("a composition-only build never skips checks", () => {
    expect(
      convergenceBuild({
        main: false,
        compositions: ["sonata"],
        head: "c4",
        mainServed: false,
      })?.skipChecks,
    ).toBe(false);
  });

  test("compositions alone name only themselves", () => {
    expect(
      convergenceBuild({
        main: false,
        compositions: ["sonata"],
        head: "c4",
        mainServed: true,
      })?.compositionArgs,
    ).toEqual(["--composition", "sonata"]);
  });

  test("nothing due is no build", () => {
    expect(
      convergenceBuild({
        main: false,
        compositions: [],
        head: "c4",
        mainServed: true,
      }),
    ).toBeNull();
  });

  test("different heads are different builds", () => {
    const at = (head: string) =>
      convergenceBuild({
        main: true,
        compositions: ["sonata"],
        head,
        mainServed: true,
      })!.key;
    expect(at("c4")).not.toBe(at("c5"));
  });
});
