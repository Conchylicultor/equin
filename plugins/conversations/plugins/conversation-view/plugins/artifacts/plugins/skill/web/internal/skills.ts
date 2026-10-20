import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { ArtifactHit } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";

/** This kind's id — the one spelling, shared by the contribution and its hits. */
export const SKILL_KIND = "skill";

/**
 * PURE. The skill this one transcript event loaded, if it loaded one.
 *
 * Always `referenced`: a skill is instructions the agent read, never something
 * the conversation made or changed.
 */
export function extractSkills(event: JsonlEvent): ArtifactHit[] {
  if (event.kind !== "tool-call" || event.name !== "Skill") return [];

  const input = event.input as { skill?: unknown } | null | undefined;
  const skill = input?.skill;
  if (typeof skill !== "string" || skill === "") return [];

  return [
    { kind: SKILL_KIND, key: skill, relation: "referenced", at: event.at },
  ];
}

/**
 * Where a skill's instructions live in THIS repo, or `null` when they do not
 * live here at all.
 *
 * A plugin skill is spelled `<plugin>:<skill>` and ships inside the plugin that
 * provides it, somewhere in the harness's own install — there is no file in
 * this checkout to open, and guessing one would send the reader to a pane that
 * says "not found". A repo skill is always `.claude/skills/<name>/SKILL.md`.
 */
export function skillFilePath(key: string): string | null {
  if (key.includes(":")) return null;
  return `.claude/skills/${key}/SKILL.md`;
}

/** Why a plugin skill's chip does not open anything — shown as its tooltip. */
export const PACKAGED_SKILL_REASON =
  "Packaged with the plugin that provides it — no SKILL.md in this repo to open";
