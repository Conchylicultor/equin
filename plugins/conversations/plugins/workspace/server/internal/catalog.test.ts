import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { listWorkspaceChoices } from "./catalog";
import {
  defineScratchProfile,
  resetScratchProfiles,
  ScratchProfile,
} from "./scratch-profile";

const bare = defineScratchProfile({
  id: "test.bare",
  label: "Bare",
  description: "input with defaults",
  inputSchema: z.object({ note: z.string().default("hi") }),
  instructions: () => "",
  mcpTools: ["flag_raise", "exit_clean"],
});
const needsInput = defineScratchProfile({
  id: "test.needs-input",
  label: "Needs input",
  description: "input without defaults",
  inputSchema: z.object({ songId: z.string() }),
  instructions: () => "",
  mcpTools: [],
});

beforeEach(resetScratchProfiles);

describe("listWorkspaceChoices", () => {
  test("the worktree, then one choice per scratch profile", async () => {
    await ScratchProfile.define(bare).register();
    await ScratchProfile.define(needsInput).register();
    const choices = listWorkspaceChoices();

    expect(choices.map((c) => c.spec)).toEqual([
      { kind: "worktree" },
      { kind: "scratch", profile: "test.bare", input: {} },
      { kind: "scratch", profile: "test.needs-input", input: {} },
    ]);
    expect(choices[0]?.capabilities).toContain("git");
    expect(choices[1]).toMatchObject({
      label: "Bare",
      capabilities: [],
      // Registered by hand, outside the register phase: no owning plugin.
      profile: { id: "test.bare", owner: null, mcpToolCount: 2 },
    });
  });

  test("a profile whose input has no defaults is listed, unavailable", async () => {
    await ScratchProfile.define(bare).register();
    await ScratchProfile.define(needsInput).register();
    const [, ok, blocked] = listWorkspaceChoices();
    expect(ok?.unavailable).toBeUndefined();
    expect(blocked?.unavailable).toBe("Needs input — started from its own app");
  });
});
