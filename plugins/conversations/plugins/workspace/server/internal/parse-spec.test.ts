import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { parseWorkspaceSpec } from "./parse-spec";
import {
  defineScratchProfile,
  resetScratchProfiles,
  ScratchProfile,
} from "./scratch-profile";

const profile = defineScratchProfile({
  id: "test.scratch",
  label: "Scratch test",
  description: "test",
  inputSchema: z.object({ note: z.string().default("hi") }),
  instructions: (input) => `# note\n${input.note}`,
  mcpTools: [],
});

beforeEach(async () => {
  resetScratchProfiles();
  await ScratchProfile.define(profile).register();
});

describe("parseWorkspaceSpec", () => {
  test("a worktree is stored as given", () => {
    expect(parseWorkspaceSpec({ kind: "worktree" })).toEqual({
      kind: "worktree",
    });
  });

  test("a scratch input is stored as its profile parses it", () => {
    expect(
      parseWorkspaceSpec({
        kind: "scratch",
        profile: "test.scratch",
        input: {},
      }),
    ).toEqual({
      kind: "scratch",
      profile: "test.scratch",
      input: { note: "hi" },
    });
  });

  test("an input the profile refuses throws", () => {
    expect(() =>
      parseWorkspaceSpec({
        kind: "scratch",
        profile: "test.scratch",
        input: { note: 3 },
      }),
    ).toThrow();
  });

  test("an unknown profile throws", () => {
    expect(() =>
      parseWorkspaceSpec({ kind: "scratch", profile: "nope", input: {} }),
    ).toThrow('Unknown scratch profile "nope"');
  });
});
