import { describe, expect, test } from "bun:test";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { createContext } from "../context";
import type { BashInput, Verdict } from "../types";
import { e2eToolUseIdGuard } from "./e2e-tool-use-id";

const ID = "toolu_01ABCdef";
const EXPORT = `export ${envName("TOOL_USE_ID")}=${ID};`;

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
        command: "./equin run plugins/x/e2e/flow.ts --url http://a",
      }),
    ).toBe(`${EXPORT} ./equin run plugins/x/e2e/flow.ts --url http://a`);
  });

  test("a chain reaches the run", () => {
    expect(
      rewritten({
        command: "./equin build && ./equin run plugins/x/e2e/f.ts",
        run_in_background: true,
      }),
    ).toStartWith(`${EXPORT} ./equin build`);
  });

  test("other commands, non-e2e runs and a payload without an id are untouched", () => {
    expect(rewritten({ command: "./equin build" })).toBeUndefined();
    expect(rewritten({ command: "./equin run scripts/x.ts" })).toBeUndefined();
    expect(rewritten({ command: "ls plugins/x/e2e/" })).toBeUndefined();
    expect(
      rewritten({ command: "./equin run plugins/x/e2e/f.ts" }, null),
    ).toBeUndefined();
    expect(
      rewritten({ command: "./equin run plugins/x/e2e/f.ts" }, "a;rm -rf /"),
    ).toBeUndefined();
  });
});
