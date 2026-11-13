import { describe, expect, test } from "bun:test";
import { defineCliCommand } from "@plugins/framework/plugins/cli/core";
import { DEFINE_CLI_COMMAND, scanCommandRuns } from "./command-runs.scan";

describe("scanCommandRuns", () => {
  test("names nested leaves by their verb path and keeps non-run imports apart", async () => {
    const scan = scanCommandRuns(
      "index.ts",
      `export default defineCliCommand({\n` +
        `  name: "deploy",\n` +
        `  description: "",\n` +
        `  subcommands: [\n` +
        `    defineCliCommand({ name: "converge", description: "", run: () => import("./converge") }),\n` +
        `    defineCliCommand({ name: "ship", description: "", run: () => import("./ship") }),\n` +
        `  ],\n` +
        `});\n` +
        `const eager = () => import("./eager");\n`,
    );
    expect(scan.runs).toEqual({
      "./converge": ["deploy converge"],
      "./ship": ["deploy ship"],
    });
    expect(scan.other).toEqual(["./eager"]);
  });

  test("a module that never mentions defineCliCommand has no run edges", async () => {
    const scan = scanCommandRuns(
      "x.ts",
      `export const run = () => import("./run");\n`,
    );
    expect(scan.runs).toEqual({});
  });

  test("recognises the CLI's own declaring function", () => {
    expect(DEFINE_CLI_COMMAND).toBe(defineCliCommand.name);
  });
});
