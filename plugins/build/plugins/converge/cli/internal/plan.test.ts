import { describe, expect, test } from "bun:test";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { convergenceBuild } from "./plan";

describe("convergenceBuild", () => {
  test("main and two compositions due at one head: one build, three targets", () => {
    const build = convergenceBuild({
      main: true,
      compositions: ["sonata", "website"],
      head: "c4",
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
    });
  });

  test("main alone is a plain build", () => {
    expect(
      convergenceBuild({
        main: true,
        compositions: [],
        head: "c4",
      }),
    ).toEqual({
      targets: [MAIN_COMPOSITION_ID],
      compositionArgs: [],
      key: `c4 ${MAIN_COMPOSITION_ID}`,
    });
  });

  test("compositions alone name only themselves", () => {
    expect(
      convergenceBuild({
        main: false,
        compositions: ["sonata"],
        head: "c4",
      })?.compositionArgs,
    ).toEqual(["--composition", "sonata"]);
  });

  test("nothing due is no build", () => {
    expect(
      convergenceBuild({
        main: false,
        compositions: [],
        head: "c4",
      }),
    ).toBeNull();
  });

  test("different heads are different builds", () => {
    const at = (head: string) =>
      convergenceBuild({
        main: true,
        compositions: ["sonata"],
        head,
      })!.key;
    expect(at("c4")).not.toBe(at("c5"));
  });
});
