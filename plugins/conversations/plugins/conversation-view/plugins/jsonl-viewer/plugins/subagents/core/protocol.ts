import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  JsonlEventSchema,
  TokenUsageSchema,
  type JsonlEvent,
} from "@plugins/conversations/plugins/transcript-source/core";

/**
 * How the parent asked for this sub-agent — and therefore what its COMPLETION
 * looks like in the parent transcript. A foreground request's `tool_result`
 * lands only when the sub-agent is done; a background request's is an immediate
 * "launched" acknowledgement that means nothing.
 *
 * Optional wherever it appears: the harness only started writing it partway
 * through Claude Code's history (missing in 396 of 818 real meta files).
 */
export const SubagentRequestShapeSchema = z.enum(["background", "foreground"]);
export type SubagentRequestShape = z.infer<typeof SubagentRequestShapeSchema>;

/**
 * Does the parent's `tool_result` for this sub-agent carry its OUTCOME, or only
 * a launch receipt?
 *
 * The single statement of the fact two different readings both depend on, so
 * they cannot drift apart: `subagentRunState` asks it to decide whether a
 * present result means "finished", and `subagentReport` asks it to decide
 * whether that result IS the write-up. A foreground `tool_result` is the call's
 * return value; a background one is an immediate "Async agent launched
 * successfully…" receipt the harness marks as internal metadata never to be
 * surfaced. An unrecorded shape could be either, so it claims neither.
 */
export function toolResultIsOutcome(
  requestShape: SubagentRequestShape | undefined,
): boolean {
  return requestShape === "foreground";
}

/**
 * The one thing a sub-agent most recently did, read off the LAST classifiable
 * line of its transcript.
 *
 * Deliberately a closed set over the raw message BLOCK type, not a tool-aware
 * phrasing: this is produced by a bounded tail read of one file, which has no
 * paired result and no whole-file parse to draw on. A tool-aware summary is a
 * separate feature over the pane's parsed events, not an extension of this.
 *
 * `toolName` exists only on the arm that has one, so a text step cannot carry a
 * tool's name.
 */
export const LastStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool"),
    toolName: z.string(),
    /** The most identifying argument (a path, a command, a pattern), truncated. */
    preview: z.string(),
  }),
  // No `preview`, deliberately. A result's text is the PAYLOAD — the file that
  // was read, the output that came back — not a description of anything, so
  // quoting it put line-numbered file contents on the card under the heading of
  // what the sub-agent is doing. There is nowhere to put that text any more,
  // which is why it cannot come back. The arm survives only for the rare window
  // holding a result whose own `tool_use` has scrolled out of it (8 of 348
  // measured occurrences); everywhere else the result defers to the call it
  // answers.
  z.object({ kind: z.literal("tool-result") }),
  z.object({ kind: z.literal("text"), preview: z.string() }),
  z.object({ kind: z.literal("thinking"), preview: z.string() }),
]);
export type LastStep = z.infer<typeof LastStepSchema>;

/**
 * What we know about a sub-agent from the FILESYSTEM alone, whether or not its
 * metadata could be read: it exists, when it started, when it last wrote, and
 * what it last did.
 */
const SubagentBaseSchema = z.object({
  agentId: z.string(),
  /** The meta file's mtime — when the harness created the sub-agent. */
  startedAt: z.string(),
  /** The transcript's mtime, or `startedAt` if it has not written yet. */
  lastActivityAt: z.string(),
  /** `null` = it has written nothing classifiable yet, not "it did nothing". */
  lastStep: LastStepSchema.nullable(),
  /**
   * The sub-agent's newest turn has ended, by its OWN transcript's marker
   * (`turnEndedOfLines`). Positive evidence only: `false` means no marker was
   * seen — also how a Claude Code version that never wrote one reads — never
   * "still working".
   */
  turnEnded: z.boolean(),
  /**
   * When its newest assistant/user line was written, by that line's own
   * `timestamp` (`newestTurnLineAt`). What a teammate's idle notification is
   * compared against: idle only counts if nothing newer is in the transcript.
   * `null` = no such line yet.
   */
  newestTurnLineAt: z.string().nullable(),
  /**
   * Every token its transcript has recorded so far, summed over its messages
   * (`foldUsageLine`). All zeros before it has written a message — it has
   * spent nothing yet, which is a fact, not a stand-in.
   */
  usage: TokenUsageSchema,
  /**
   * Set when a `Workflow` run spawned this agent (found under
   * `subagents/workflows/wf_<runId>/`). On BOTH arms: an agent whose meta is
   * unreadable still sits in its run's folder, so it still belongs to the run.
   *
   * `reported` = the run's journal holds this agent's `result` line — the
   * workflow equivalent of a foreground `tool_result`, and the only completion
   * signal such an agent has, since it joins no `Agent` call.
   */
  workflow: z.object({ runId: z.string(), reported: z.boolean() }).optional(),
});

/**
 * One sub-agent, as its `agent-<id>.meta.json` describes it.
 *
 * **Only `agentType` and `description` are guaranteed.** The meta file's field
 * set has GROWN across Claude Code versions, and a conversation's directory
 * holds sub-agents from every version it has ever run under — so a schema
 * modelled on one recent directory rejects the older half of the corpus.
 * Measured over the 818 real meta files on this machine (2026-09-20):
 *
 * | field           | missing |
 * | --------------- | ------- |
 * | `agentType`     |       0 |
 * | `description`   |       0 |
 * | `spawnDepth`    |       7 |
 * | `model`         |      34 |
 * | `toolUseId`     |     306 |
 * | `requestShape`  |     396 |
 * | `parentAgentId` |     802 |
 *
 * An absent field means **the harness did not record it**, which is a fact, not
 * a stand-in — so a surface omits the reading rather than inventing a default.
 * `toolUseId` in particular is absent for every in-process teammate, which has a
 * transcript but no `Agent` card in the parent to be reached from.
 */
export const DescribedSubagentSchema = SubagentBaseSchema.extend({
  kind: z.literal("described"),
  agentType: z.string(),
  description: z.string(),
  toolUseId: z.string().optional(),
  /**
   * The name the parent asked for, when it asked for one. Present almost exactly
   * when `toolUseId` is absent: naming a sub-agent makes it an in-process
   * teammate, and the harness records a teammate's name INSTEAD of a tool-use
   * id. It is therefore the only join key such a sub-agent has.
   */
  name: z.string().optional(),
  model: z.string().optional(),
  requestShape: SubagentRequestShapeSchema.optional(),
  spawnDepth: z.number().int().optional(),
  parentAgentId: z.string().optional(),
  /** A workflow agent's phase title, from its meta. Absent for every other sub-agent. */
  workflowPhase: z.string().optional(),
});
export type DescribedSubagent = z.infer<typeof DescribedSubagentSchema>;

/**
 * A sub-agent whose metadata could not be read at all — corrupt JSON, or a
 * `requestShape` naming something this build has never heard of.
 *
 * It is still a ROW. The alternative shapes were both wrong: dropping it hides a
 * sub-agent that demonstrably exists, and filling in defaults would have the
 * card state things about it that nothing on disk supports. Because it is a
 * separate arm, a reader can tell "this sub-agent's metadata is unreadable" from
 * "this sub-agent has no recorded model" — which a flat row with optional fields
 * could not express.
 *
 * Everything the filesystem knows survives, so the card can still show when it
 * started and what it last did.
 */
export const UndescribedSubagentSchema = SubagentBaseSchema.extend({
  kind: z.literal("undescribed"),
  /** Why it could not be described, short enough to put in front of a person. */
  reason: z.string(),
});
export type UndescribedSubagent = z.infer<typeof UndescribedSubagentSchema>;

/**
 * One sub-agent of one conversation.
 *
 * A union, not a flat row with an error flag: one sub-agent the harness wrote
 * before a field existed must never be able to take out the whole list. Before
 * this, a single 2024-era meta threw inside the loader, the resource errored,
 * and NO card in the conversation rendered.
 */
export const SubagentActivityRowSchema = z.discriminatedUnion("kind", [
  DescribedSubagentSchema,
  UndescribedSubagentSchema,
]);
export type SubagentActivityRow = z.infer<typeof SubagentActivityRowSchema>;

export const SubagentActivityPayloadSchema = z.array(SubagentActivityRowSchema);

/**
 * Everything a parent's `Agent` call offers for finding the sub-agent it
 * spawned. Two keys, because the harness writes one or the other, never both.
 */
export interface SubagentJoin {
  /** The parent's `Agent` tool-use id. */
  toolUseId: string;
  /**
   * The `name` that call requested, when it named one. Read from the call's own
   * input, so a caller holding the rendered event needs nothing else.
   */
  requestedName?: string;
}

/** The join keys a parent's `Agent` tool-call event carries. */
export function agentCallJoin(
  event: Extract<JsonlEvent, { kind: "tool-call" }>,
): SubagentJoin {
  const input = event.input;
  const requested =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).name
      : undefined;
  return {
    toolUseId: event.toolUseId,
    requestedName:
      typeof requested === "string" && requested !== "" ? requested : undefined,
  };
}

/**
 * The sub-agent a parent's `Agent` call spawned.
 *
 * The one sanctioned join from a rendered card to its row, so no surface has to
 * know that a sub-agent has one of TWO keys:
 *
 * - **tool-use id** — an ordinary sub-agent. Unique by construction.
 * - **name** — a sub-agent spawned WITH a name, which Claude Code records as an
 *   in-process teammate and writes NO `toolUseId` for. Its card still exists and
 *   still has an id; only the meta lacks one, so an id-only join leaves the card
 *   with no duration, no last step, and a button onto a pane that can never
 *   resolve. Measured over the 818 metas on this machine, 307 are
 *   named-with-no-id and 301 are recoverable this way — the common case, not a
 *   fringe one.
 *
 * A name is **not** an id, so the name match is guarded twice: it considers only
 * rows carrying no `toolUseId` of their own (a row with one belongs to some
 * other card), and it refuses a name that more than one row answers to. Two
 * teammates sharing a name in one session is something the harness permits and
 * resolves as "latest wins" — but that rule is about which LIVE teammate a
 * message reaches, and a transcript join has no "live". Picking either would put
 * another sub-agent's work under this card, so it refuses; `undefined` already
 * means "no row", which a card renders as "starting" rather than as a claim.
 * (Zero collisions occur across the 175 sessions on this machine.)
 *
 * `undefined` also covers the ordinary case of a sub-agent that has not written
 * its meta file yet.
 */
export function describedSubagent(
  rows: readonly SubagentActivityRow[],
  join: SubagentJoin,
): DescribedSubagent | undefined {
  const described = rows.filter(
    (row): row is DescribedSubagent => row.kind === "described",
  );
  const byId = described.find((row) => row.toolUseId === join.toolUseId);
  if (byId) return byId;
  if (join.requestedName === undefined) return undefined;

  const byName = described.filter(
    (row) => row.toolUseId === undefined && row.name === join.requestedName,
  );
  return byName.length === 1 ? byName[0] : undefined;
}

/**
 * A sub-agent's own transcript, or the fact that no file is claimed by that
 * tool-use id yet.
 *
 * A discriminated result, never an empty array: "the file isn't there yet" and
 * "the sub-agent did nothing" must not share a spelling, or a card that is still
 * starting renders as one that ran and produced nothing.
 *
 * Three arms, because "no transcript" has two meanings a pane must not treat
 * alike:
 *
 * - `unlinked`   — nothing claims this card YET. Ordinary and temporary; the
 *                  pane shows a loading state, because the file may land any
 *                  moment.
 * - `unjoinable` — a sub-agent exists but nothing can prove it is THIS card's
 *                  (two teammates answer to the requested name). Permanent, so
 *                  the pane says so instead of spinning forever waiting for
 *                  something that will never arrive.
 */
export const SubagentTranscriptSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("linked"),
    agentId: z.string(),
    events: z.array(JsonlEventSchema),
  }),
  z.object({ kind: z.literal("unlinked") }),
  z.object({ kind: z.literal("unjoinable"), reason: z.string() }),
]);
export type SubagentTranscript = z.infer<typeof SubagentTranscriptSchema>;

export type SubagentTranscriptEvents = JsonlEvent[];

/**
 * Every sub-agent of one conversation, in start order. ONE subscription serves
 * every card in the conversation — `useLive` is a TanStack Query wrapper, so N
 * cards on identical params share one query and one subscription. Not loaded
 * yet is `pending` (a value has no placeholder), never an empty list.
 */
export const subagentActivity = liveValue("subagent-activity", {
  schema: SubagentActivityPayloadSchema,
  params: ["id"],
});

/**
 * Which sub-agent a surface means — by one of its TWO keys, because the
 * surfaces that open one hold different things:
 *
 * - `call`  — the parent's `Agent` tool-use id. What a transcript card and a
 *   completion notification hold, and the only key that exists BEFORE the
 *   harness writes the sub-agent's files, so a card clicked at launch still
 *   opens a pane that fills in. The server joins it to a file through the
 *   meta files (id, else the name the call requested).
 * - `agent` — the sub-agent's own id, which names its files directly. What a
 *   list of sub-agents holds, and the only key that reaches a named teammate
 *   spawned by another sub-agent: its `Agent` call lives in that sub-agent's
 *   transcript, which the call-keyed join does not read.
 *
 * Flat, so it spreads straight into resource params and a pane route.
 */
export const SubagentRefSchema = z.object({
  by: z.enum(["call", "agent"]),
  key: z.string(),
});
export type SubagentRef = z.infer<typeof SubagentRefSchema>;

/**
 * One sub-agent's transcript, keyed by the parent conversation plus whichever
 * {@link SubagentRef} the opening surface holds (spread flat: `{ id, by, key }`);
 * the server re-parses the ref and resolves it to a file. Not loaded yet is
 * `pending` — never `unlinked`, which is a settled answer ("no file claims this
 * card yet"), not a stand-in.
 */
export const subagentTranscript = liveValue("subagent-transcript", {
  schema: SubagentTranscriptSchema,
  params: ["id", "by", "key"],
});
