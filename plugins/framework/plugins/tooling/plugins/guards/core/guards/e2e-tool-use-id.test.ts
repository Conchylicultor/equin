import { describe, expect, test } from "bun:test";
import { createContext } from "../context";
import type { BashInput, Verdict } from "../types";
import { e2eToolUseIdGuard } from "./e2e-tool-use-id";

const ID = "toolu_01ABCdef";

function rewritten(input: BashInput, toolUseId: string | null = ID) {
  const v = e2eToolUseIdGuard.check(
    input,
    createContext("/tmp", "s", [], undefined, null, toolUseId),
  ) as Verdict;
  return v.kind === "rewrite" ? v.patch.command : undefined;
}

describe("e2e-tool-use-id guard", () => {
  test("an e2e run gets the call's id exported in front", () => {
    expect(
      rewritten({
        command: "./singularity run plugins/x/e2e/flow.ts --url http://a",
      }),
    ).toBe(
      `export SINGULARITY_TOOL_USE_ID=${ID}; ./singularity run plugins/x/e2e/flow.ts --url http://a`,
    );
  });

  test("a chain reaches the run", () => {
    expect(
      rewritten({
        command: "./singularity build && ./singularity run plugins/x/e2e/f.ts",
        run_in_background: true,
      }),
    ).toMatch(
      /^export SINGULARITY_TOOL_USE_ID=toolu_01ABCdef; \.\/singularity build/,
    );
  });

  test("other commands, non-e2e runs and a payload without an id are untouched", () => {
    expect(rewritten({ command: "./singularity build" })).toBeUndefined();
    expect(
      rewritten({ command: "./singularity run scripts/x.ts" }),
    ).toBeUndefined();
    expect(rewritten({ command: "ls plugins/x/e2e/" })).toBeUndefined();
    expect(
      rewritten({ command: "./singularity run plugins/x/e2e/f.ts" }, null),
    ).toBeUndefined();
    expect(
      rewritten(
        { command: "./singularity run plugins/x/e2e/f.ts" },
        "a;rm -rf /",
      ),
    ).toBeUndefined();
  });
});
