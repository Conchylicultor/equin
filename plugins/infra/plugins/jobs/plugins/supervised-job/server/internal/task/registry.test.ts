import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SUPERVISED_EXEC_COMMAND } from "../../../core";
import { defineSupervisedTask } from "./registry";

const payload = z.object({ n: z.number() });
const run = () => Promise.resolve();

describe("defineSupervisedTask invoke", () => {
  test("states the namespace, and no admission when none is declared", () => {
    const { argv } = defineSupervisedTask({
      id: "t.plain",
      payload,
      run,
    }).invoke({
      n: 1,
    });
    expect(argv.slice(1, 4)).toEqual([
      SUPERVISED_EXEC_COMMAND,
      "t.plain",
      '{"n":1}',
    ]);
    expect(argv).toContain("--namespace");
    expect(argv).not.toContain("--admit");
  });

  test("a declared admission pool travels as --admit <pool>", () => {
    const { argv } = defineSupervisedTask({
      id: "t.admitted",
      payload,
      run,
      admission: "worktree-prepare",
    }).invoke({ n: 1 });
    const at = argv.indexOf("--admit");
    expect(at).toBeGreaterThan(0);
    expect(argv[at + 1]).toBe("worktree-prepare");
  });
});
