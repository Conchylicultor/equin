import { prototypeIdsIn } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type {
  ArtifactHit,
  Relation,
} from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";

/**
 * This kind's id. Shared by the contribution and every hit it emits — the host
 * throws on a hit filed under another kind's name, and one const is what makes
 * that impossible here.
 */
export const PROTOTYPE_KIND = "prototype";

type ToolCall = Extract<JsonlEvent, { kind: "tool-call" }>;

/**
 * The command that MINTS a prototype: `./singularity prototype new [title]`.
 *
 * The id it makes is printed by the command — the caller never writes it — so
 * the `created` hit is read off the result, which is the only place it exists.
 */
const MINT_COMMAND_RE = /\bprototype\s+new\b/;

/**
 * The tools that write a file. A prototype id in one of their paths is a write
 * INSIDE that prototype's folder, because the id is only ever a folder name:
 * a prototype is one self-contained directory whose name IS its id.
 */
const WRITING_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/** One string field of a tool call's input, or nothing when it is not one. */
function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** The ids a `prototype new` call brought into existence. */
function mintedIds(event: ToolCall): string[] {
  if (event.name !== "Bash") return [];
  const command = stringField(event.input, "command");
  if (command === undefined || !MINT_COMMAND_RE.test(command)) return [];
  // Still running, or the mint failed — either way nothing was made yet, so
  // there is nothing to claim as created. A later sighting still lists it.
  if (event.result === undefined || event.result.isError === true) return [];
  return prototypeIdsIn(event.result.content);
}

/** The ids whose folder this call wrote into. */
function writtenIds(event: ToolCall): string[] {
  if (!WRITING_TOOLS.has(event.name)) return [];
  const path = stringField(event.input, "file_path");
  if (path === undefined) return [];
  return prototypeIdsIn(path);
}

function hit(key: string, relation: Relation, at: string): ArtifactHit {
  return { kind: PROTOTYPE_KIND, key, relation, at };
}

/**
 * Every prototype one transcript event touched, and what it did to each.
 *
 * What counts as a mention — the id's shape, the word guard, the walk over a
 * tool input's string leaves — is `prototypeIdsIn`, which lives beside the mint
 * it has to agree with and is shared with the end-of-turn checkpoint job. All
 * this adds is the reading: *which* part of the event to scan, and what the
 * scan means.
 *
 * - A `prototype new` command **created** what it printed.
 * - A `Write`/`Edit` whose path is inside a prototype's folder **edited** it.
 * - Every other mention — a `Read`, a `Bash` line, the prompt of an `Agent`
 *   call, a bare id in the agent's or the user's own words — **referenced** it.
 *
 * The same call can be all three at once, and each id is judged on its own: a
 * `Write` into one prototype whose content quotes another's id edited the first
 * and only referenced the second.
 *
 * One event, not the whole transcript: the host runs this per event and folds
 * the repeats, keeping the strongest relation anyone reported.
 */
export function extractPrototypeHits(event: JsonlEvent): ArtifactHit[] {
  // Prose, not a call: the agent naming a prototype in its answer, or the user
  // naming one in their request. Nothing was done to it, so it is a reference.
  if (event.kind === "assistant-text" || event.kind === "user-text") {
    return prototypeIdsIn(event.text).map((key) =>
      hit(key, "referenced", event.at),
    );
  }
  if (event.kind !== "tool-call") return [];

  const hits: ArtifactHit[] = [];
  for (const key of mintedIds(event)) hits.push(hit(key, "created", event.at));

  const written = new Set(writtenIds(event));
  for (const key of prototypeIdsIn(event.input)) {
    hits.push(hit(key, written.has(key) ? "edited" : "referenced", event.at));
  }
  return hits;
}
