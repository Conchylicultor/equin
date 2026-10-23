import { describe, expect, test } from "bun:test";
import { createContext } from "../context";
import type { BashInput, Verdict } from "../types";
import {
  backgroundTimeoutGuard,
  MAX_BACKGROUND_TIMEOUT_MS,
} from "./background-timeout";

function verdict(input: BashInput): Verdict {
  return backgroundTimeoutGuard.check(input, createContext("/tmp")) as Verdict;
}

const patched = (input: BashInput) => {
  const v = verdict(input);
  return v.kind === "rewrite" ? v.patch.timeout : undefined;
};

describe("background-timeout guard", () => {
  test("a backgrounded build with no timeout gets the ceiling", () => {
    expect(
      patched({ command: "./singularity build", run_in_background: true }),
    ).toBe(MAX_BACKGROUND_TIMEOUT_MS);
  });

  test("an explicit shorter timeout is raised", () => {
    expect(
      patched({
        command: "./singularity push -m 'x'",
        run_in_background: true,
        timeout: 1_800_000,
      }),
    ).toBe(MAX_BACKGROUND_TIMEOUT_MS);
  });

  test("an e2e run is covered like any other subcommand", () => {
    expect(
      patched({
        command:
          "./singularity run plugins/upstream/e2e/clone-journey.ts --keep",
        run_in_background: true,
      }),
    ).toBe(MAX_BACKGROUND_TIMEOUT_MS);
  });

  test("the canonical ./equin spelling is covered too", () => {
    expect(patched({ command: "./equin build", run_in_background: true })).toBe(
      MAX_BACKGROUND_TIMEOUT_MS,
    );
  });

  test("already at the ceiling: untouched", () => {
    expect(
      verdict({
        command: "./singularity build",
        run_in_background: true,
        timeout: MAX_BACKGROUND_TIMEOUT_MS,
      }).kind,
    ).toBe("allow");
  });

  test("foreground and non-singularity commands are untouched", () => {
    expect(verdict({ command: "./singularity check --list" }).kind).toBe(
      "allow",
    );
    expect(
      verdict({ command: "sleep 5000", run_in_background: true }).kind,
    ).toBe("allow");
  });
});
