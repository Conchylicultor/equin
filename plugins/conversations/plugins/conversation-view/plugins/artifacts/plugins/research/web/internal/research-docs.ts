import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type {
  ArtifactHit,
  Relation,
} from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";

/** This kind's id — the one spelling, shared by the contribution and its hits. */
export const RESEARCH_KIND = "research";

/**
 * Which tools touch a file, and what touching it that way means.
 *
 * `MultiEdit` is here even though it is not in the plan's list: it is an `Edit`
 * that carries several replacements, and a design doc rewritten with it would
 * otherwise be missing from the list with no way for the reader to tell.
 */
const RELATION_BY_TOOL: Record<string, Relation> = {
  Write: "created",
  Edit: "edited",
  MultiEdit: "edited",
  Read: "referenced",
};

/**
 * A design doc, as the `plan` skill names one: `research/<name>.md` at the repo
 * root, or `sidequests/<quest>/research/<name>.md` for a sidequest's own.
 *
 * Matched as a SUFFIX because a tool call carries an absolute path (the `Read`
 * tool demands one), and anchored at a path separator so `my-research/x.md`
 * does not read as a research doc. The captured tail is what we keep: a
 * repo-relative path is what the file-peek pane takes, and it is short enough
 * to show in a tooltip.
 */
const RESEARCH_PATH_RE =
  /(?:^|\/)(sidequests\/[^/]+\/research\/[^/]+\.md|research\/[^/]+\.md)$/;

/**
 * The repo-relative path of the research doc this file path names, or `null`
 * when it names something else. A classification, not a fallible read — every
 * path has an answer, and most paths' answer is "not a research doc".
 */
export function researchPathOf(filePath: string): string | null {
  return RESEARCH_PATH_RE.exec(filePath)?.[1] ?? null;
}

/** PURE. Every research doc this one transcript event touched. */
export function extractResearch(event: JsonlEvent): ArtifactHit[] {
  if (event.kind !== "tool-call") return [];
  const relation = RELATION_BY_TOOL[event.name];
  if (relation === undefined) return [];

  const input = event.input as { file_path?: unknown } | null | undefined;
  const filePath = input?.file_path;
  if (typeof filePath !== "string") return [];

  const key = researchPathOf(filePath);
  if (key === null) return [];
  return [{ kind: RESEARCH_KIND, key, relation, at: event.at }];
}

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/;

/**
 * What to call a research doc on its row.
 *
 * The file name is `YYYY-MM-DD-<category>-<name>.md` — the date and the
 * category are both filing clerk, not title, and in this popover the category
 * is the same for nearly every row (they came out of one conversation). So both
 * go, and what is left is spelled as a sentence. The whole path stays in the
 * row's tooltip, which is where someone checking *which* doc this is will look.
 *
 * A sidequest's docs are named `YYYY-MM-DD-<name>.md` with no category segment
 * (the sidequest is the category), so only the date comes off those.
 */
export function researchTitle(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1).replace(/\.md$/, "");
  const words = base.replace(DATE_PREFIX_RE, "").split("-");
  // Never leave the row nameless: a doc whose whole name IS the category keeps it.
  if (!key.startsWith("sidequests/") && words.length > 1) words.shift();
  const phrase = words.join(" ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
