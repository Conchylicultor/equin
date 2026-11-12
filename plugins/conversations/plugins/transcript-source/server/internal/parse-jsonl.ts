import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { unwrapEventTurn } from "@plugins/conversations/plugins/turn-ledger/core";
import {
  extractPreprompt,
  activeLineUuids,
  unwrapRelayEnvelopes,
  crossSessionMessageOf,
  extractTeammateMessages,
  stripRelayBoilerplate,
  unwrapPastedContent,
  userPromptText,
  questionAnswerText,
  mergedSendUuids,
  tokenUsageOf,
  QuestionAnswerSchema,
  requestConfigChanges,
  requestShapeChange,
  hookRecordOf,
  resultBlockOf,
  sameHookOutcome,
} from "../../core";
import type {
  JsonlEvent,
  QuestionAnswer,
  RequestShape,
  UserTextSegment,
  ToolCallResult,
  HookRecord,
  TranscriptImage,
} from "../../core";
import { requestConfigOf, requestShapeOf } from "./api-request";
import { base64ImageSize, imageMimeOf } from "./image-key";
import { transcriptSlicer } from "./slicing";

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;
type ApiRequestEvent = Extract<JsonlEvent, { kind: "api-request" }>;
type CompactionEvent = Extract<JsonlEvent, { kind: "compaction" }>;

/** The `compactMetadata` a `compact_boundary` line carries; every field optional, since Claude Code owns the shape. */
const CompactMetadataSchema = z.object({
  trigger: z.string().optional(),
  preTokens: z.number().optional(),
  postTokens: z.number().optional(),
});

/**
 * A `file-history-delta` line — Claude Code's per-file rewind checkpoint. Only
 * the fields the checkpoint row reads; a line that does not match falls
 * through to `kind: "unknown"` (loud, with its raw payload) rather than
 * rendering a half-understood checkpoint.
 */
const FileHistoryDeltaSchema = z.object({
  trackingPath: z.string().min(1),
  backup: z.object({
    backupFileName: z.string().nullable(),
    realParentDir: z.string().min(1),
  }),
});

/** The preamble Claude Code puts before every compact summary — the harness talking, not the summary. */
const COMPACT_SUMMARY_PREAMBLE =
  /^This session is being continued from a previous conversation[^\n]*\n+(?:Summary:\s*\n)?/;

/** The instructions Claude Code appends after every compact summary, addressed to the agent. */
const COMPACT_SUMMARY_POSTSCRIPT =
  /\n+(?:If you need specific details from before compaction|Continue the conversation from where it left off)[\s\S]*$/;

/**
 * A line of the `/compact` command the user typed, which Claude Code writes
 * AFTER the compaction it ran (between the summary and the re-read files): the
 * local-command caveat (`isMeta`), the command itself (under the turn's uuid,
 * its args the user's focus instructions), and its stdout. Null for any other
 * line.
 */
function compactCommandLine(
  obj: Record<string, unknown>,
  text: string,
):
  | { kind: "caveat" | "stdout" }
  | { kind: "command"; uuid: string | undefined; instructions: string }
  | null {
  if (obj.type !== "user") return null;
  const trimmed = text.trimStart();
  if (obj.isMeta === true)
    return trimmed.startsWith("<local-command-caveat>")
      ? { kind: "caveat" }
      : null;
  if (trimmed.startsWith("<local-command-stdout>")) return { kind: "stdout" };
  if (!trimmed.startsWith("<command-name>/compact</command-name>")) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(trimmed);
  return {
    kind: "command",
    uuid: typeof obj.uuid === "string" ? obj.uuid : undefined,
    instructions: args?.[1]?.trim() ?? "",
  };
}

/** The attachment subtypes Claude Code writes for the files it re-reads right after compacting. */
const COMPACTION_FILE_SUBTYPES = new Set(["file", "compact_file_reference"]);

function compactionFile(
  att: Record<string, unknown>,
): CompactionEvent["files"][number] | null {
  if (typeof att.filename !== "string") return null;
  const content = att.content as { file?: { numLines?: unknown } } | undefined;
  const lines = content?.file?.numLines;
  return {
    path: att.filename,
    lines: typeof lines === "number" ? lines : undefined,
  };
}

const xmlParser = new XMLParser({ parseTagValue: false, trimValues: true });

type Segment = UserTextSegment;

const KNOWN_NOTIFICATION_KEYS = new Set([
  "task-id",
  "tool-use-id",
  "status",
  "summary",
  "output-file",
]);

/** Where the event builder's helpers put the events they make. */
interface EventSink {
  push(event: JsonlEvent): void;
}

function extractTaskNotifications(
  text: string,
  at: string,
  out: EventSink,
): string {
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push(m[0]);

    let parsed: Record<string, unknown> = {};
    try {
      const result = xmlParser.parse(m[0]) as Record<string, unknown>;
      const inner = result["task-notification"];
      if (inner && typeof inner === "object") {
        parsed = inner as Record<string, unknown>;
      }
    } catch (err) {
      // fast-xml-parser throws generic Error instances on malformed XML;
      // re-throw anything that is not a standard Error (unexpected runtime throw)
      if (!(err instanceof Error)) throw err;
      continue;
    }

    const str = (v: unknown): string =>
      typeof v === "string" ? v : typeof v === "number" ? String(v) : "";

    const taskId = str(parsed["task-id"]);
    const toolUseId = str(parsed["tool-use-id"]) || undefined;
    const status = str(parsed["status"]);
    const summary = str(parsed["summary"]);
    const outputFile = str(parsed["output-file"]) || undefined;

    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!KNOWN_NOTIFICATION_KEYS.has(k)) {
        const s = str(v);
        if (s) extra[k] = s;
      }
    }

    if (taskId || status || summary) {
      out.push({
        kind: "task-notification",
        at,
        taskId,
        toolUseId,
        status,
        summary,
        outputFile,
        extra: Object.keys(extra).length > 0 ? extra : undefined,
      });
    }
  }
  let stripped = text;
  for (const block of blocks) {
    stripped = stripped.replace(block, "");
  }
  return stripped.trim();
}

/**
 * Keys an image a prompt references by absolute path (`@/path/shot.png`) — its
 * `TranscriptImage.key`, the page loading the bytes by URL, and its natural
 * size when the host read it from the file's header — or `null` when the host
 * has no such image, which renders the reference as plain text. The host's
 * own: a desktop stats the file, a host without one has none.
 */
export type TranscriptImageReader = (
  path: string,
) => Promise<Omit<TranscriptImage, "mime"> | null>;

/**
 * A `queued_command` attachment carrying a human prompt (`commandMode`
 * "prompt", or none on older lines) — not a harness control message such as a
 * task notification — with the uuid it was sent under.
 */
function humanQueuedPrompt(
  att: Record<string, unknown>,
): { prompt: string; uuid: string | undefined } | null {
  if (att.type !== "queued_command" || typeof att.prompt !== "string") {
    return null;
  }
  if (att.commandMode !== undefined && att.commandMode !== "prompt") {
    return null;
  }
  return {
    prompt: att.prompt,
    uuid: typeof att.source_uuid === "string" ? att.source_uuid : undefined,
  };
}

// The merged sends ride on a row only beside the line uuid they share it with
// (a row with no uuid names no line), and only when there are any.
function mergedOf(
  uuid: string | undefined,
  merged: string[],
): { mergedSendUuids?: string[] } {
  return uuid !== undefined && merged.length > 0
    ? { mergedSendUuids: merged }
    : {};
}

async function pushTextWithImages(
  text: string,
  at: string,
  out: EventSink,
  uuid: string | undefined,
  merged: string[],
  readImage: TranscriptImageReader,
): Promise<void> {
  // Local regex instance — the g flag stores match state in lastIndex, so a
  // shared module-level regex gets corrupted when concurrent async calls
  // (from the file watcher) interleave at await points.
  // `[^\s@]` (not `\S`) excludes `@` from the path body so two concatenated
  // refs (`@path1.png@path2.png`, from legacy transcripts written before the
  // attachment rewrite added separators) parse as two tokens instead of the
  // greedy match fusing them into one non-existent path.
  const re = /@(\/[^\s@]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|tiff))/gi;

  const segments: Segment[] = [];
  let last = 0;
  let hasImages = false;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const before = text.slice(last, m.index);
    if (before) segments.push({ kind: "text", value: before });

    const path = m[1]!;
    const keyed = await readImage(path);
    if (keyed !== null) {
      segments.push({
        kind: "image",
        image: { ...keyed, mime: imageMimeOf(path) },
      });
      hasImages = true;
    } else {
      segments.push({ kind: "text", value: m[0] });
    }

    last = m.index + m[0].length;
  }

  const after = text.slice(last);
  if (after) segments.push({ kind: "text", value: after });

  if (segments.length === 0) return;

  if (!hasImages) {
    if (text.trim()) {
      out.push({
        kind: "user-text",
        at,
        text,
        uuid,
        ...mergedOf(uuid, merged),
      });
    }
    return;
  }

  const plainText = segments
    .filter((s): s is { kind: "text"; value: string } => s.kind === "text")
    .map((s) => s.value)
    .join("");

  out.push({
    kind: "user-text",
    at,
    text: plainText,
    segments,
    uuid,
    ...mergedOf(uuid, merged),
  });
}

interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  tool_name?: string;
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
    width?: number;
    height?: number;
  };
  /** A held tool result's first image's size (`TranscriptLines` dropped the image). */
  image_size?: { width?: unknown; height?: unknown };
}

/** A size field as the held line carries it: a positive integer, else absent. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** The natural size of a tool result's first image, as `ToolCallResult.imageSize`. */
function toolResultImageSize(block: RawBlock): ToolCallResult["imageSize"] {
  const held = block.image_size;
  if (
    held &&
    typeof held.width === "number" &&
    typeof held.height === "number"
  ) {
    return { width: held.width, height: held.height };
  }
  if (!Array.isArray(block.content)) return undefined;
  const first = (block.content as (RawBlock | null)[]).find(
    (part) =>
      part?.type === "image" &&
      part.source?.type === "base64" &&
      typeof part.source.data === "string",
  );
  if (!first?.source?.data) return undefined;
  const size = base64ImageSize(first.source.data);
  return size.width !== undefined && size.height !== undefined
    ? { width: size.width, height: size.height }
    : undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as RawBlock[]) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/** The tool names a result's `tool_reference` blocks point at, or undefined
 *  when it has none (the common case: every result but a tool search's). */
function extractToolReferences(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const names: string[] = [];
  for (const block of content as RawBlock[]) {
    /* eslint-disable @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements */
    if (
      block?.type === "tool_reference" &&
      typeof block.tool_name === "string"
    ) {
      names.push(block.tool_name);
    }
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  }
  return names.length > 0 ? names : undefined;
}

/**
 * The structured answer an answered AskUserQuestion line carries in its
 * `toolUseResult` (`{questions, answers, annotations?, response?}`), or
 * undefined when the line is any other tool's result. `toolUseResult` is
 * per line, not per block, so it is only attributed when the line holds a
 * single tool_result. A line shaped like an answer that fails the schema
 * throws: the CLI changed its record, and the card must not guess.
 */
function extractQuestionAnswer(
  obj: Record<string, unknown>,
  toolResultCount: number,
): QuestionAnswer | undefined {
  if (toolResultCount !== 1) return undefined;
  const r = obj.toolUseResult;
  if (typeof r !== "object" || r === null) return undefined;
  if (!("questions" in r) || !("answers" in r)) return undefined;
  return QuestionAnswerSchema.parse(r);
}

/**
 * The preprompt a `prompt_snapshot` attachment's system prompt carries: the
 * <special_instructions> block the launch appends as the prompt's last segment
 * (`systemPrompt.append`), or null when it ends in anything else.
 */
function snapshotPreprompt(att: Record<string, unknown>): string | null {
  const segments = att.systemPrompt;
  if (!Array.isArray(segments)) return null;
  const last: unknown = segments.at(-1);
  if (typeof last !== "string") return null;
  return extractPreprompt(last).preprompt;
}

/**
 * Records a hook on the call it ran on, once: a block is read off the call's
 * result AND may be written again as a `hook_*` attachment.
 */
function addHook(call: ToolCallEvent, hook: HookRecord | undefined): void {
  if (!hook) return;
  if (call.hooks?.some((h) => sameHookOutcome(h, hook))) return;
  call.hooks = [...(call.hooks ?? []), hook];
}

/**
 * The transcript's events, from its merged chain lines (`mergeChainLines`):
 * the live branch only, tool calls paired with their results, prompts'
 * referenced images inlined through `readImage`.
 */
export async function buildJsonlEvents(
  parsed: readonly Record<string, unknown>[],
  readImage: TranscriptImageReader,
): Promise<JsonlEvent[]> {
  // The merged transcript is a forest (uuid / parentUuid); a rewind/edit leaves
  // the abandoned branch behind. Compute which lines belong to the live
  // conversation and skip the rest, so the view shows what the user kept
  // rather than abandoned attempts inline. Run once over the whole chain — a
  // per-file pass would not see a fork's prompt superseding its ancestor's.
  // Lines without a uuid (metadata markers) are not in the tree and always
  // pass through.
  const keptUuids = activeLineUuids(parsed);
  const builder = new JsonlEventBuilder(readImage);
  await builder.add(
    parsed.filter(
      (obj) => typeof obj.uuid !== "string" || keptUuids.has(obj.uuid),
    ),
  );
  return builder.events();
}

/**
 * The transcript's events, built a batch of lines at a time: `add` folds the
 * next lines of the live branch (in chain order, rewound lines already left
 * out) into the builder's cross-line state — a tool call and its later result,
 * a message split over lines, the open compaction, the Stop hooks pending —
 * and `events()` answers what `buildJsonlEvents` would over every line added
 * so far. An append costs its own lines, not the transcript.
 *
 * - **What `events()` returns is never changed afterwards.** A later line may
 *   change an event already returned (a tool result, the next chunk of a
 *   message): the builder mutates its own copy, marks it (`touch`), and the
 *   next `events()` publishes a fresh copy of it — readers comparing two
 *   answers see the change, and an earlier answer stays what it was. Every
 *   mutation of an emitted event goes through `touch`.
 * - **A line dropped after it was added cannot be taken back**: a rewind
 *   (`BranchForest`) that drops a line the builder already folded in needs a
 *   new builder over the live branch — the caller's (`TranscriptLines`).
 */
export class JsonlEventBuilder {
  /** The events built so far, task notifications deduplicated: the builder's own, mutated in place. */
  private readonly working: JsonlEvent[] = [];
  /** `working` as last published, index for index (a prefix of it: new events are published by the next `events()`). */
  private readonly published: JsonlEvent[] = [];
  /** Each working event's index in `working` — how a touched event is found without a scan. */
  private readonly indexOf = new Map<JsonlEvent, number>();
  /** Working events changed since they were published. */
  private readonly touched = new Set<JsonlEvent>();
  /** When the last event made was — a duplicate notification included, which `working` leaves out. */
  private lastAt: string | undefined;
  // Background-task completions surface up to three times in the raw
  // transcript (queue enqueue at completion, dequeue when sent, delivered copy
  // in the next user turn) — all parse to the same task-notification. Only the
  // earliest (completion time) is kept. Keyed by tool-use id when present,
  // else by the notification's identifying fields.
  private readonly seenNotifications = new Set<string>();
  private readonly sink: EventSink = { push: (event) => this.emit(event) };

  private readonly assistantTextByMsgId = new Map<
    string,
    JsonlEvent & { kind: "assistant-text" }
  >();
  private readonly usageAttributedMsgIds = new Set<string>();
  // The latest `end_turn` text whose Stop hooks have not answered yet, and
  // whether one of them blocked it. Claude Code writes the turn's last
  // message, then runs its Stop hooks — a block as a `hook_blocking_error`
  // attachment — then one `stop_hook_summary` line, which settles `stopHooks`.
  private stopPending: (JsonlEvent & { kind: "assistant-text" }) | null = null;
  private stopBlocked = false;
  // tool-call pairing: toolUseId → emitted ToolCallEvent (result populated later)
  private readonly toolCallByUseId = new Map<string, ToolCallEvent>();
  // Deferred tool results whose call hasn't appeared yet
  private readonly pendingResults: {
    toolUseId: string;
    result: ToolCallResult;
  }[] = [];
  // Lines whose tool result the CLI filled in on resume because the session
  // ended mid-call (`toolDenialKind: "interrupted"`): the synthetic reply it
  // appends to such a line ("No response requested.") is skipped below.
  private readonly sessionEndedResultLines = new Set<string>();
  // The launch preprompt (wrapped in <special_instructions>) becomes a
  // dedicated `preprompt` event, rendered as a collapsed Instructions card at
  // the head of the conversation. It is found where the agent was given it:
  // appended to the system prompt, which the CLI records in its
  // `prompt_snapshot` attachments (`preprompt-from-snapshot`) — or, for a
  // conversation launched before that, baked into the first user turn, where
  // it is lifted out so it does not render as raw user text. Only
  // ever appears once; set true on a real hit so a later turn can't re-trigger.
  // Scoped to one build of the whole chain: a chained tail that re-injects
  // <special_instructions> would emit a second `preprompt` event. Not observed;
  // no global dedup until a test shows it firing.
  private seenPreprompt = false;
  // The compaction being folded: its boundary line opens it, and the summary
  // and the re-read files that follow join it. Any line that is neither (an
  // assistant turn, the next prompt) closes it.
  private compaction: CompactionEvent | null = null;
  // The last `api-request` row emitted per caller (`querySource`): a call is
  // emitted only when it is the caller's first or differs from its previous
  // one; an identical call is counted into that row's `calls` instead, so ~one
  // line per model call collapses to the changes without losing the trace.
  // Keyed per caller so a side caller (compaction, a subagent) using other
  // settings does not read as the main thread flipping back and forth.
  private readonly lastRequestBySource = new Map<string, ApiRequestEvent>();
  // The previous `api-request-shape` line's shape: each one is diffed against
  // it, so a later row reads as what changed (a tool loaded, the prompt edited).
  private lastShape: RequestShape | null = null;

  constructor(private readonly readImage: TranscriptImageReader) {}

  /**
   * The events of every line added so far — a new array each call, whose
   * events are never changed afterwards.
   */
  events(): JsonlEvent[] {
    for (const event of this.touched) {
      const i = this.indexOf.get(event);
      if (i === undefined)
        throw new Error("a touched event is not in the transcript");
      if (i < this.published.length) this.published[i] = { ...event };
    }
    this.touched.clear();
    for (let i = this.published.length; i < this.working.length; i++) {
      this.published.push({ ...this.working[i]! });
    }
    const out = this.published.slice();
    // Results that arrived before their call (shouldn't happen in normal flow,
    // but handle gracefully): paired at the end, on copies — a later line may
    // still pair or change the call, and this answer must not change with it.
    const patched = new Set<number>();
    for (const { toolUseId, result } of this.pendingResults) {
      const call = this.toolCallByUseId.get(toolUseId);
      if (call) {
        const i = this.indexOf.get(call);
        if (i === undefined)
          throw new Error("a paired call is not in the transcript");
        const copy = patched.has(i)
          ? (out[i] as ToolCallEvent)
          : { ...(out[i] as ToolCallEvent) };
        patched.add(i);
        copy.result = result;
        if (result.isError)
          addHook(copy, resultBlockOf(result.content, result.at));
        out[i] = copy;
      } else {
        // Orphan result — no matching call; emit as a tool-call with empty name
        out.push({
          kind: "tool-call",
          at: result.at,
          toolUseId,
          name: "",
          input: null,
          result,
        });
      }
    }
    return out;
  }

  /** Mark an emitted event as changed — before every mutation of one. */
  private touch<T extends JsonlEvent>(event: T): T {
    this.touched.add(event);
    return event;
  }

  private emit(event: JsonlEvent): void {
    this.lastAt = event.at;
    if (event.kind === "task-notification") {
      const key =
        event.toolUseId ??
        `${event.taskId}|${event.status}|${event.summary}|${event.outputFile ?? ""}`;
      if (this.seenNotifications.has(key)) return;
      this.seenNotifications.add(key);
    }
    this.indexOf.set(event, this.working.length);
    this.working.push(event);
  }

  /**
   * The preprompt as the head of the conversation: just before its first user
   * prompt, which the snapshot recording it follows. With no prompt yet, at the
   * end, stamped with the snapshot's time.
   */
  private insertBeforeFirstPrompt(text: string, ts: string): void {
    const i = this.working.findIndex(
      (e) => e.kind === "user-text" || e.kind === "user-image",
    );
    if (i === -1) {
      this.emit({ kind: "preprompt", at: ts, text });
      return;
    }
    const event: JsonlEvent = {
      kind: "preprompt",
      at: this.working[i]!.at,
      text,
    };
    this.working.splice(i, 0, event);
    // Once per transcript (the preprompt appears once): reindex the shifted tail.
    for (let j = i; j < this.working.length; j++) {
      this.indexOf.set(this.working[j]!, j);
    }
    if (i < this.published.length) this.published.splice(i, 0, { ...event });
  }

  // One home for user-turn text handling, shared by the string-content branch
  // and the array text-block branch. In order: lift the launch preprompt,
  // decode any harness relay envelopes, extract teammate-message blocks (each
  // emitted as its own event), strip the relay scaffolding, then route the rest
  // through task-notification extraction + image-aware push.
  private async processUserText(
    rawText: string,
    ts: string,
    promptUuid: string | undefined,
    lineUuid: string | undefined,
    // The other sends the CLI merged into this line (`mergedSendUuids`).
    merged: string[],
  ): Promise<void> {
    // First, before anything looks for a tag: the CLI wraps whatever it took
    // as a paste, so a relay envelope or a task-notification pasted into the
    // prompt would otherwise stay hidden inside `<pasted_content>`.
    let body = unwrapPastedContent(rawText);
    // An `event` turn the app delivered is the whole text, in the ledger's
    // envelope: one event card, never the user's message (`userPromptText`
    // says the same, so the line carries no rewind cut point).
    const event = unwrapEventTurn(body);
    if (event !== null) {
      this.emit({
        kind: "event-turn",
        at: ts,
        text: event,
        uuid: lineUuid,
        ...mergedOf(lineUuid, merged),
      });
      return;
    }
    if (!this.seenPreprompt) {
      const { preprompt, rest } = extractPreprompt(body);
      if (preprompt) {
        this.seenPreprompt = true;
        this.emit({ kind: "preprompt", at: ts, text: preprompt });
        body = rest;
      }
    }
    body = unwrapRelayEnvelopes(body);
    const { messages, rest: afterTeammates } = extractTeammateMessages(body);
    for (const msg of messages) {
      this.emit({
        kind: "teammate-message",
        at: ts,
        teammateId: msg.teammateId,
        color: msg.color,
        summary: msg.summary,
        body: msg.body,
      });
    }
    body =
      messages.length > 0
        ? stripRelayBoilerplate(afterTeammates)
        : afterTeammates;
    const remaining = extractTaskNotifications(body, ts, this.sink);
    if (remaining.length > 0) {
      await pushTextWithImages(
        remaining,
        ts,
        this.sink,
        promptUuid,
        merged,
        this.readImage,
      );
    }
  }

  /** Fold the next lines of the live branch, in chain order. */
  async add(lines: readonly Record<string, unknown>[]): Promise<void> {
    // A long chain's build would hold the thread for seconds (task-notification
    // XML, text processing): yield between lines, on the transcript turn queue.
    const slice = transcriptSlicer();
    for (const obj of lines) {
      await slice();
      const uuid = typeof obj.uuid === "string" ? obj.uuid : null;
      const ts = typeof obj.timestamp === "string" ? obj.timestamp : null;
      // `JsonlEvent.at` must be a parseable instant for every consumer — a
      // string that fails Date.parse (NaN) would make comparisons against it
      // silently false rather than loudly wrong, so drop the line here instead
      // of downstream.
      if (!ts || Number.isNaN(Date.parse(ts))) continue;

      const type = obj.type;
      const msg = obj.message as
        | {
            role?: string;
            content?: unknown;
            id?: string;
            model?: string;
            stop_reason?: string;
          }
        | undefined;
      if (
        this.compaction &&
        type !== "attachment" &&
        obj.isCompactSummary !== true
      ) {
        const command = compactCommandLine(obj, extractText(msg?.content));
        if (command) {
          if (command.kind === "command") {
            if (command.uuid)
              this.touch(this.compaction).requestUuid = command.uuid;
            if (command.instructions)
              this.touch(this.compaction).instructions = command.instructions;
          }
          continue;
        }
        this.compaction = null;
      }

      if (type === "user" && obj.isCompactSummary === true) {
        // The summary the agent continues from — written by the harness, never
        // a message the user sent. A summary with no boundary before it still
        // folds into a compaction of its own.
        if (!this.compaction) {
          this.compaction = { kind: "compaction", at: ts, files: [] };
          this.emit(this.compaction);
        }
        const summary = extractText(msg?.content)
          .replace(COMPACT_SUMMARY_PREAMBLE, "")
          .replace(COMPACT_SUMMARY_POSTSCRIPT, "")
          .trim();
        if (summary) this.touch(this.compaction).summary = summary;
        continue;
      }

      if (type === "user" && msg?.role === "user") {
        const isMeta = obj.isMeta === true;
        const sourceToolUseID =
          typeof obj.sourceToolUseID === "string" ? obj.sourceToolUseID : null;
        if (isMeta && sourceToolUseID) {
          const linked = this.toolCallByUseId.get(sourceToolUseID);
          if (linked) {
            const text = extractText(msg.content);
            if (text) {
              this.touch(linked).injectedContext = [
                ...(linked.injectedContext ?? []),
                text,
              ];
            }
            continue;
          }
        }

        if (isMeta) {
          const text = extractText(msg.content);
          // A message another Claude session sent: the peer's own words, as an
          // inbound message card — never the harness wrapper around them.
          const peer = crossSessionMessageOf(obj, text);
          if (peer) {
            this.emit({
              kind: "teammate-message",
              at: ts,
              teammateId: peer.name,
              body: peer.body,
              session: { name: peer.name, mode: peer.mode, hops: peer.hops },
            });
            continue;
          }
          // Harness-injected prompt (loop/queue wakeup, resume, local-command
          // caveat) with no originating tool call. Surface it as its own kind so
          // it never renders as a human-authored user message.
          if (text) {
            this.emit({
              kind: "meta-prompt",
              at: ts,
              source:
                typeof obj.promptSource === "string"
                  ? obj.promptSource
                  : undefined,
              text,
            });
          }
          continue;
        }

        // The line's uuid rides on the row only when the line is a message the
        // user typed — the same predicate a rewind applies to its cut point.
        const promptUuid =
          uuid && userPromptText(obj) !== null ? uuid : undefined;
        const content = msg.content;
        if (typeof content === "string") {
          await this.processUserText(
            content,
            ts,
            promptUuid,
            uuid ?? undefined,
            mergedSendUuids(obj),
          );
        } else if (Array.isArray(content)) {
          const questionAnswer = extractQuestionAnswer(
            obj,
            (content as RawBlock[]).filter(
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
              (b) => b?.type === "tool_result",
            ).length,
          );
          const sessionEnded = obj.toolDenialKind === "interrupted";
          if (sessionEnded && uuid) this.sessionEndedResultLines.add(uuid);
          // The same predicate a rewind applies to an answer it cuts at.
          const answerUuid =
            uuid && questionAnswerText(obj) !== null ? uuid : undefined;
          for (const block of content as RawBlock[]) {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
            if (block?.type === "tool_result") {
              const toolUseId =
                typeof block.tool_use_id === "string" ? block.tool_use_id : "";
              const result: ToolCallResult = {
                at: ts,
                content: extractText(block.content),
                isError: block.is_error === true ? true : undefined,
                outcomeUnknown: sessionEnded ? true : undefined,
                toolReferences: extractToolReferences(block.content),
                imageSize: toolResultImageSize(block),
                questionAnswer,
                answerUuid,
              };
              const existing = this.toolCallByUseId.get(toolUseId);
              if (existing) {
                this.touch(existing).result = result;
                if (result.isError)
                  addHook(existing, resultBlockOf(result.content, ts));
              } else {
                this.pendingResults.push({ toolUseId, result });
              }
            } else if (
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
              block?.type === "text" &&
              typeof block.text === "string"
            ) {
              await this.processUserText(
                block.text,
                ts,
                promptUuid,
                uuid ?? undefined,
                mergedSendUuids(obj),
              );
            } else if (
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
              block?.type === "image" &&
              block.source?.type === "ref" &&
              typeof block.source.data === "string"
            ) {
              // `TranscriptLines` put the image's key where its bytes were.
              this.emit({
                kind: "user-image",
                at: ts,
                image: {
                  key: block.source.data,
                  mime:
                    typeof block.source.media_type === "string"
                      ? block.source.media_type
                      : "image/jpeg",
                  width: positiveInt(block.source.width),
                  height: positiveInt(block.source.height),
                },
              });
            }
          }
        }
        continue;
      }

      if (type === "assistant" && msg?.role === "assistant") {
        if (!Array.isArray(msg.content)) continue;
        // The CLI's own filler after a result it filled in on resume — no model
        // wrote it, and the result's card already says the session ended.
        if (
          msg.model === "<synthetic>" &&
          typeof obj.parentUuid === "string" &&
          this.sessionEndedResultLines.has(obj.parentUuid)
        ) {
          continue;
        }
        if (obj.isApiErrorMessage === true) {
          this.emit({
            kind: "api-error",
            at: ts,
            error: typeof obj.error === "string" ? obj.error : undefined,
            text: (msg.content as RawBlock[])
              .flatMap((block) =>
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
                block?.type === "text" && typeof block.text === "string"
                  ? [block.text]
                  : [],
              )
              .join("\n"),
          });
          continue;
        }
        const msgId = msg.id;
        const lineUsage = tokenUsageOf((msg as { usage?: unknown }).usage);
        const shouldAttributeUsage =
          !!lineUsage && !!msgId && !this.usageAttributedMsgIds.has(msgId);
        let usageAnchor:
          | (JsonlEvent & ({ kind: "assistant-text" } | { kind: "tool-call" }))
          | null = null;
        const setUsageOnce = (
          event: JsonlEvent &
            ({ kind: "assistant-text" } | { kind: "tool-call" }),
        ) => {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; values may change by the time setUsageOnce is called
          if (!shouldAttributeUsage || !lineUsage || !msgId) return;
          if (usageAnchor) {
            if (usageAnchor === event) this.touch(event).usage = lineUsage;
            return;
          }
          usageAnchor = event;
          this.touch(event).usage = lineUsage;
          this.usageAttributedMsgIds.add(msgId);
        };
        for (const block of msg.content as RawBlock[]) {
          if (
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
            block?.type === "thinking" &&
            typeof block.thinking === "string"
          ) {
            this.emit({
              kind: "assistant-thinking",
              at: ts,
              messageId: msgId,
              thinking: block.thinking,
            });
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
          } else if (block?.type === "text" && typeof block.text === "string") {
            if (msgId) {
              const existing = this.assistantTextByMsgId.get(msgId);
              if (existing) {
                this.touch(existing).text += block.text;
                if (msg.stop_reason) existing.stopReason = msg.stop_reason;
                setUsageOnce(existing);
                continue;
              }
            }
            const event: JsonlEvent & { kind: "assistant-text" } = {
              kind: "assistant-text",
              at: ts,
              messageId: msgId,
              text: block.text,
              stopReason: msg.stop_reason ?? undefined,
            };
            if (msgId) this.assistantTextByMsgId.set(msgId, event);
            setUsageOnce(event);
            this.emit(event);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
          } else if (block?.type === "tool_use") {
            const toolUseId = typeof block.id === "string" ? block.id : "";
            const event: ToolCallEvent = {
              kind: "tool-call",
              at: ts,
              messageId: msgId,
              toolUseId,
              name: typeof block.name === "string" ? block.name : "",
              input: block.input,
            };
            setUsageOnce(event);
            this.emit(event);
            this.toolCallByUseId.set(toolUseId, event);
          }
        }
        if (msgId && msg.stop_reason) {
          const existing = this.assistantTextByMsgId.get(msgId);
          if (existing && !existing.stopReason) {
            this.touch(existing).stopReason = msg.stop_reason;
          }
          if (existing?.stopReason === "end_turn") {
            this.stopPending = existing;
            this.stopBlocked = false;
          }
        }
        continue;
      }

      if (type === "system" && obj.subtype === "stop_hook_summary") {
        if (this.stopPending) {
          this.touch(this.stopPending).stopHooks = this.stopBlocked
            ? "blocked"
            : "allowed";
          this.stopPending = null;
        }
        this.stopBlocked = false;
        continue;
      }

      if (type === "system" && obj.subtype === "compact_boundary") {
        const meta = CompactMetadataSchema.safeParse(obj.compactMetadata);
        this.compaction = {
          kind: "compaction",
          at: ts,
          ...(meta.success ? meta.data : {}),
          files: [],
        };
        this.emit(this.compaction);
        continue;
      }

      if (type === "system") {
        const subtype =
          typeof obj.subtype === "string" ? (obj.subtype as string) : undefined;
        const text =
          typeof obj.content === "string"
            ? (obj.content as string)
            : typeof (obj as { text?: unknown }).text === "string"
              ? (obj as { text: string }).text
              : extractText((obj as { message?: unknown }).message);
        if (text) this.emit({ kind: "system", at: ts, subtype, text });
        continue;
      }

      if (type === "summary") {
        const text =
          typeof (obj as { summary?: unknown }).summary === "string"
            ? (obj as { summary: string }).summary
            : "";
        if (text) this.emit({ kind: "summary", at: ts, text });
        continue;
      }

      if (type === "attachment") {
        const att = obj.attachment;
        if (att && typeof att === "object") {
          const subtype =
            typeof (att as Record<string, unknown>).type === "string"
              ? ((att as Record<string, unknown>).type as string)
              : "unknown";
          if (this.compaction && COMPACTION_FILE_SUBTYPES.has(subtype)) {
            const file = compactionFile(att as Record<string, unknown>);
            if (file) {
              const open = this.touch(this.compaction);
              open.files = [...open.files, file];
              continue;
            }
          }
          // A prompt the user sent while the agent worked, folded into the
          // running turn at a tool boundary: the CLI writes it as this
          // attachment, never as a user line — so it becomes the user's
          // message here, under the uuid the agent gave it (`source_uuid`,
          // what the turn ledger's confirmation names). The line carries the
          // enqueue time; the message entered the conversation where it sits.
          const queued = humanQueuedPrompt(att as Record<string, unknown>);
          if (queued) {
            const prev = this.lastAt;
            const at = prev && Date.parse(prev) > Date.parse(ts) ? prev : ts;
            await this.processUserText(
              queued.prompt,
              at,
              queued.uuid,
              queued.uuid,
              [],
            );
            continue;
          }
          if (subtype === "prompt_snapshot" && !this.seenPreprompt) {
            const preprompt = snapshotPreprompt(att as Record<string, unknown>);
            if (preprompt) {
              this.seenPreprompt = true;
              this.insertBeforeFirstPrompt(preprompt, ts);
            }
          }
          // A hook record that names a call rides on that call, as its result
          // does: the hook ran ON it, and a block means it never ran. The call
          // is always earlier in the transcript than its hooks (pre-hooks land
          // between call and result, a block's record after the result). A
          // record naming no call (SessionStart, UserPromptSubmit, Stop) or an
          // unknown call stays an event of its own.
          const hook = hookRecordOf(
            subtype,
            att as Record<string, unknown>,
            ts,
          );
          if (
            hook.kind === "hook" &&
            hook.record.event === "Stop" &&
            subtype === "hook_blocking_error"
          ) {
            this.stopBlocked = true;
          }
          if (hook.kind === "hook" && hook.toolUseId) {
            const call = this.toolCallByUseId.get(hook.toolUseId);
            if (call) {
              addHook(this.touch(call), hook.record);
              continue;
            }
          }
          this.emit({ kind: "attachment", at: ts, subtype, attachment: att });
        }
        continue;
      }

      if (type === "queue-operation") {
        const content =
          typeof obj.content === "string" ? (obj.content as string) : undefined;
        // A background-task completion is enqueued (and later dequeued) as a raw
        // <task-notification> block, then delivered again in the agent's next
        // user turn — three transcript lines for one event. Parse the block into
        // a structured task-notification here; the dedup pass below collapses all
        // copies into a single row.
        if (content && content.includes("<task-notification>")) {
          extractTaskNotifications(content, ts, this.sink);
        }
        // A queued prompt's own lines are its lifecycle, not a message: while it
        // waits the page shows its echo (the turn ledger), and once delivered it
        // is a user line (`dequeue`) or a folded-in `queued_command` attachment
        // (`remove` — delivered, not discarded).
        continue;
      }

      if (type === "file-history-delta") {
        const delta = FileHistoryDeltaSchema.safeParse(obj);
        if (delta.success) {
          const { trackingPath, backup } = delta.data;
          // `trackingPath` is worktree-relative for files inside the checkout and
          // absolute outside it; `realParentDir` is always the absolute directory.
          const name = trackingPath.slice(trackingPath.lastIndexOf("/") + 1);
          this.emit({
            kind: "file-checkpoint",
            at: ts,
            path: trackingPath.startsWith("/")
              ? trackingPath
              : `${backup.realParentDir}/${name}`,
            created: backup.backupFileName === null,
          });
          continue;
        }
      }

      if (type === "api-request") {
        const config = requestConfigOf(obj);
        if (config) {
          const source =
            typeof obj.querySource === "string" ? obj.querySource : "";
          const last = this.lastRequestBySource.get(source);
          if (last && requestConfigChanges(last.config, config).length === 0) {
            this.touch(last).calls += 1;
            continue;
          }
          const event: ApiRequestEvent = {
            kind: "api-request",
            at: ts,
            source,
            config,
            previous: last?.config ?? null,
            calls: 1,
          };
          this.lastRequestBySource.set(source, event);
          this.emit(event);
          continue;
        }
      }

      if (type === "api-request-shape") {
        const shape = requestShapeOf(obj);
        if (shape) {
          const change = this.lastShape
            ? requestShapeChange(this.lastShape, shape)
            : null;
          this.lastShape = shape;
          // A shape differing only in what this does not read (a tool's
          // description or schema) would be a row saying nothing changed.
          if (
            change &&
            change.toolsAdded.length === 0 &&
            change.toolsRemoved.length === 0 &&
            !change.systemChanged
          ) {
            continue;
          }
          this.emit({ kind: "request-shape", at: ts, shape, change });
          continue;
        }
      }

      this.emit({
        kind: "unknown",
        at: ts,
        type: typeof type === "string" ? type : "unknown",
        raw: obj,
      });
    }
  }
}
