import { describe, expect, test } from "bun:test";
import { agentScratchDir, foreignTempPath } from "./agent-scratch";

const ownDir = agentScratchDir("conv-1-abc");
const SID = "615f223d-ac72-45b2-9bb8-6f7d361d78da";
const own = { scratchDir: ownDir, claudeSessionId: SID };

describe("agentScratchDir", () => {
  test("one directory per owner under the scratch root", () => {
    expect(ownDir).toBe("/tmp/equin-scratch/conv-1-abc");
    expect(agentScratchDir("615f223d-ac72-45b2-9bb8-6f7d361d78da")).toBe(
      "/tmp/equin-scratch/615f223d-ac72-45b2-9bb8-6f7d361d78da",
    );
  });
  test("an owner that is not one path segment is refused", () => {
    for (const bad of ["", "a/b", "..", "a..b", "/x", ".hidden"])
      expect(() => agentScratchDir(bad)).toThrow(/not a session id/);
  });
});

describe("foreignTempPath", () => {
  test("a fixed name in a shared temp root is foreign", () => {
    expect(foreignTempPath("/tmp/msg.txt", own)).toBe("/tmp/msg.txt");
    expect(foreignTempPath("/private/tmp/msg.txt", own)).toBe("/tmp/msg.txt");
    expect(foreignTempPath("/var/tmp/x/y", own)).toBe("/var/tmp/x/y");
    expect(foreignTempPath("/private/var/tmp/x", own)).toBe("/var/tmp/x");
  });
  test("another session's scratch is foreign", () => {
    expect(foreignTempPath("/tmp/equin-scratch/conv-2/msg.txt", own)).toBe(
      "/tmp/equin-scratch/conv-2/msg.txt",
    );
    expect(foreignTempPath("/tmp/equin-scratch", own)).toBe(
      "/tmp/equin-scratch",
    );
  });
  test("this session's scratch, the roots themselves and other places are not", () => {
    expect(foreignTempPath(`${ownDir}/msg.txt`, own)).toBeNull();
    expect(foreignTempPath(ownDir, own)).toBeNull();
    expect(foreignTempPath(`/private${ownDir}/x`, own)).toBeNull();
    expect(foreignTempPath("/tmp", own)).toBeNull();
    expect(foreignTempPath("/private/tmp", own)).toBeNull();
    expect(foreignTempPath("/tmpfoo/x", own)).toBeNull();
    expect(foreignTempPath("/opt/x", own)).toBeNull();
    expect(foreignTempPath(`${ownDir}-evil/x`, own)).toBe(`${ownDir}-evil/x`);
  });
  test("Claude Code's directory for this session is its own, another's is not", () => {
    const harness = `/private/tmp/claude-501/-Users-me-repo/${SID}`;
    expect(foreignTempPath(`${harness}/scratchpad/h.ts`, own)).toBeNull();
    expect(foreignTempPath(`${harness}/tasks/b1.output`, own)).toBeNull();
    expect(foreignTempPath("/tmp/claude-501/-Users-me-repo/other/x", own)).toBe(
      "/tmp/claude-501/-Users-me-repo/other/x",
    );
    expect(foreignTempPath("/tmp/claude-501/x", own)).toBe("/tmp/claude-501/x");
  });
});
