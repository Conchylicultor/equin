import { describe, expect, test } from "bun:test";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { noMemoryGuard } from "./no-memory";

// A deliberately fake repo root (not under /Users — see paths:no-hardcoded-paths).
const WT = "/r/repo/.claude/worktrees/att-123-abcd";
const MEM = `${HOME_DIR}/.claude/projects/-r-repo/memory`;

function verdict(input: { file_path?: string; command?: string }): Verdict {
  return noMemoryGuard.check(input, createContext(WT)) as Verdict;
}
const blocks = (input: { file_path?: string; command?: string }) =>
  verdict(input).kind === "deny";

describe("no-memory guard", () => {
  test("blocks Write/Edit of a memory file and the index", () => {
    expect(blocks({ file_path: `${MEM}/some-fact.md` })).toBe(true);
    expect(blocks({ file_path: `${MEM}/MEMORY.md` })).toBe(true);
  });

  test("blocks shell writes into the memory dir", () => {
    expect(blocks({ command: `echo x > ${MEM}/fact.md` })).toBe(true);
    expect(blocks({ command: `cp /tmp/fact.md ${MEM}/fact.md` })).toBe(true);
    expect(blocks({ command: `tee ${MEM}/fact.md` })).toBe(true);
  });

  test("blocks a checkout's .claude/memory dir", () => {
    expect(blocks({ file_path: `${WT}/.claude/memory/MEMORY.md` })).toBe(true);
    expect(blocks({ command: `echo x > .claude/memory/fact.md` })).toBe(true);
  });

  test("allows removing and reading memories", () => {
    expect(blocks({ command: `rm ${MEM}/fact.md` })).toBe(false);
    expect(blocks({ command: `cat ${MEM}/MEMORY.md` })).toBe(false);
  });

  test("leaves other ~/.claude/projects paths and the worktree alone", () => {
    expect(
      blocks({
        file_path: `${HOME_DIR}/.claude/projects/-r-repo/s1/workflows/scripts/a.js`,
      }),
    ).toBe(false);
    expect(blocks({ file_path: `${WT}/memory/notes.md` })).toBe(false);
    expect(blocks({ command: `echo x > ${WT}/memory/notes.md` })).toBe(false);
  });
});
