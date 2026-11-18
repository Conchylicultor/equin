import { describe, expect, test } from "bun:test";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { convergenceBuild, describeNothingToBuild } from "./plan";

const BUILD = { kind: "build", retry: 0 } as const;
const CONVERGED = { kind: "converged" } as const;

describe("convergenceBuild", () => {
  test("main and two compositions due at one head: one build, three targets", () => {
    const build = convergenceBuild({
      main: BUILD,
      compositions: ["sonata", "website"],
    });
    expect(build).toEqual({
      targets: [MAIN_COMPOSITION_ID, "sonata", "website"],
      compositionArgs: [
        "--composition",
        MAIN_COMPOSITION_ID,
        "sonata",
        "website",
      ],
    });
  });

  test("main alone is a plain build", () => {
    expect(
      convergenceBuild({
        main: BUILD,
        compositions: [],
      }),
    ).toEqual({
      targets: [MAIN_COMPOSITION_ID],
      compositionArgs: [],
    });
  });

  test("compositions alone name only themselves", () => {
    expect(
      convergenceBuild({
        main: CONVERGED,
        compositions: ["sonata"],
      })?.compositionArgs,
    ).toEqual(["--composition", "sonata"]);
  });

  test("nothing due is no build", () => {
    expect(
      convergenceBuild({
        main: CONVERGED,
        compositions: [],
      }),
    ).toBeNull();
  });
});

describe("describeNothingToBuild", () => {
  const A = "aaaaaaa1111111111111111111111111111111a";
  const B = "bbbbbbb2222222222222222222222222222222b";
  const servedA = { ok: true, commit: A } as const;

  test("converged only when the served dist names HEAD", () => {
    expect(
      describeNothingToBuild({ main: CONVERGED, head: A, served: servedA }),
    ).toEqual({ level: "info", line: "converged at aaaaaaa11: it is served" });
  });

  test("2026-11-18: a failed deploy names the run and the commit still served, never 'converged'", () => {
    const said = describeNothingToBuild({
      main: {
        kind: "failed",
        attempt: { id: "build-x", commit: B, outcome: "failed" },
      },
      head: B,
      served: servedA,
    });
    expect(said.level).toBe("warn");
    expect(said.line).toStartWith(
      "deploy of bbbbbbb22 failed (build-x): still serves aaaaaaa11.",
    );
    expect(said.line).not.toContain("converged");
  });

  test("spent retries fail the run, so the gateway files it", () => {
    const killed = { commit: B, outcome: "no-verdict" } as const;
    const said = describeNothingToBuild({
      main: {
        kind: "retries-spent",
        attempts: [
          { id: "build-1", ...killed },
          { id: "build-2", ...killed },
          { id: "build-3", ...killed },
        ],
      },
      head: B,
      served: servedA,
    });
    expect(said.level).toBe("error");
    expect(said.line).toContain("build-1, build-2, build-3");
    expect(said.line).toContain("still serves aaaaaaa11");
  });
});
