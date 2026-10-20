import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { extractSkills, skillFilePath } from "./skills";

function skillCall(input: unknown): JsonlEvent {
  return namedCall("Skill", input);
}

function namedCall(name: string, input: unknown): JsonlEvent {
  return {
    kind: "tool-call",
    at: "2026-09-19T10:00:00Z",
    toolUseId: "t-skill",
    name,
    input,
  };
}

describe("extractSkills", () => {
  test("a Skill call is the skill it names, referenced", () => {
    expect(extractSkills(skillCall({ skill: "plan", args: "" }))).toEqual([
      {
        kind: "skill",
        key: "plan",
        relation: "referenced",
        at: "2026-09-19T10:00:00Z",
      },
    ]);
  });

  test("a packaged skill keeps its qualified name as the key", () => {
    expect(
      extractSkills(skillCall({ skill: "anthropic-skills:docx" }))[0]?.key,
    ).toBe("anthropic-skills:docx");
  });

  test("a call with no skill name, and another tool, find nothing", () => {
    expect(extractSkills(skillCall({}))).toEqual([]);
    expect(extractSkills(skillCall({ skill: "" }))).toEqual([]);
    expect(extractSkills(skillCall({ skill: 7 }))).toEqual([]);
    expect(extractSkills(namedCall("Read", { skill: "plan" }))).toEqual([]);
  });

  test("text merely naming a skill is not a Skill call", () => {
    expect(
      extractSkills({
        kind: "assistant-text",
        at: "2026-09-19T10:00:00Z",
        text: "I will use the plan skill",
      }),
    ).toEqual([]);
  });
});

describe("skillFilePath", () => {
  test("a repo skill has a SKILL.md to open", () => {
    expect(skillFilePath("debug")).toBe(".claude/skills/debug/SKILL.md");
  });

  test("a packaged skill has no file in this repo", () => {
    expect(skillFilePath("anthropic-skills:pdf")).toBeNull();
  });
});
