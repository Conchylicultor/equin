import { expect, test } from "bun:test";
import {
  CLAUDE_PROJECTS_DIR,
  claudeProjectDirName,
  claudeTranscriptPath,
} from "./paths";

test("claudeProjectDirName", () => {
  expect(claudeProjectDirName("/home/u/.equin/state/workspaces/att-1")).toBe(
    "-home-u--equin-state-workspaces-att-1",
  );
  expect(claudeProjectDirName("/w/__A__/dev/repo/.claude/wt")).toBe(
    "-w---A---dev-repo--claude-wt",
  );
});

test("claudeProjectDirName caps a long cwd and appends Claude Code's hash", () => {
  // The expected suffix is Claude Code's own (its cli's sanitizer, run on the
  // same cwd): the first 200 characters, then `-` and the cwd's string hash.
  const cwd = `/w/${"a".repeat(250)}`;
  expect(claudeProjectDirName(cwd)).toBe(`-w-${"a".repeat(197)}-9arrx5`);
});

test("claudeTranscriptPath", () => {
  expect<string>(claudeTranscriptPath("/w/att-1", "sid")).toBe(
    `${CLAUDE_PROJECTS_DIR}/-w-att-1/sid.jsonl`,
  );
});

test("claudeTranscriptPath refuses an empty cwd", () => {
  expect(() => claudeTranscriptPath("", "sid")).toThrow("no cwd");
});
