import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import {
  extractPreprompt,
  activeLineUuids,
  unwrapRelayEnvelopes,
  extractTeammateMessages,
  stripRelayBoilerplate,
  unwrapPastedContent,
  userPromptText,
  tokenUsageOf,
  QuestionAnswerSchema,
  requestConfigChanges,
  requestShapeChange,
} from "../../core";
import type {
  JsonlEvent,
  QuestionAnswer,
  RequestShape,
  UserTextSegment,
  ToolCallResult,
} from "../../core";
import { requestConfigOf, requestShapeOf } from "./api-request";
import { imageMimeOf } from "./image-key";

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

function extractTaskNotifications(
  text: string,
  at: string,
  out: JsonlEvent[],
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
 * `TranscriptImage.key`, the page loading the bytes by URL — or `null` when the
 * host has no such image, which renders the reference as plain text. The
 * host's own: a desktop stats the file, a host without one has none.
 */
export type TranscriptImageReader = (path: string) => Promise<string | null>;

async function pushTextWithImages(
  text: string,
  at: string,
  out: JsonlEvent[],
  uuid: string | undefined,
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
    const key = await readImage(path);
    if (key !== null) {
      segments.push({
        kind: "image",
        image: { key, mime: imageMimeOf(path) },
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
    if (text.trim()) out.push({ kind: "user-text", at, text, uuid });
    return;
  }

  const plainText = segments
    .filter((s): s is { kind: "text"; value: string } => s.kind === "text")
    .map((s) => s.value)
    .join("");

  out.push({ kind: "user-text", at, text: plainText, segments, uuid });
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
  };
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
  const keptUuids = activeLineUuids(parsed);

  const events: JsonlEvent[] = [];
  const assistantTextByMsgId = new Map<
    string,
    JsonlEvent & { kind: "assistant-text" }
  >();
  const usageAttributedMsgIds = new Set<string>();
  // tool-call pairing: toolUseId → emitted ToolCallEvent (result populated later)
  const toolCallByUseId = new Map<string, ToolCallEvent>();
  // Deferred tool results whose call hasn't appeared yet
  const pendingResults: { toolUseId: string; result: ToolCallResult }[] = [];
  // Lines whose tool result the CLI filled in on resume because the session
  // ended mid-call (`toolDenialKind: "interrupted"`): the synthetic reply it
  // appends to such a line ("No response requested.") is skipped below.
  const sessionEndedResultLines = new Set<string>();
  // The launch preprompt is baked into the first user turn (wrapped in
  // <special_instructions>). Lift it out into a dedicated `preprompt` event so
  // it renders as a collapsed Instructions card, not as raw user text. Only
  // ever appears once; set true on a real hit so a later turn can't re-trigger.
  // Scoped to one parse of the whole chain: a chained tail that re-injects
  // <special_instructions> would emit a second `preprompt` event. Not observed;
  // no global dedup until a test shows it firing.
  let seenPreprompt = false;
  // The compaction being folded: its boundary line opens it, and the summary
  // and the re-read files that follow join it. Any line that is neither (an
  // assistant turn, the next prompt) closes it.
  let compaction: CompactionEvent | null = null;
  // The last `api-request` row emitted per caller (`querySource`): a call is
  // emitted only when it is the caller's first or differs from its previous
  // one; an identical call is counted into that row's `calls` instead, so ~one
  // line per model call collapses to the changes without losing the trace.
  // Keyed per caller so a side caller (compaction, a subagent) using other
  // settings does not read as the main thread flipping back and forth.
  const lastRequestBySource = new Map<string, ApiRequestEvent>();
  // The previous `api-request-shape` line's shape: each one is diffed against
  // it, so a later row reads as what changed (a tool loaded, the prompt edited).
  let lastShape: RequestShape | null = null;

  // One home for user-turn text handling, shared by the string-content branch
  // and the array text-block branch (which previously duplicated it). Closes
  // over `seenPreprompt` and `events`. In order: lift the launch preprompt,
  // decode any harness relay envelopes, extract teammate-message blocks (each
  // emitted as its own event), strip the relay scaffolding, then route the rest
  // through task-notification extraction + image-aware push.
  const processUserText = async (
    rawText: string,
    ts: string,
    promptUuid: string | undefined,
  ): Promise<void> => {
    // First, before anything looks for a tag: the CLI wraps whatever it took
    // as a paste, so a relay envelope or a task-notification pasted into the
    // prompt would otherwise stay hidden inside `<pasted_content>`.
    let body = unwrapPastedContent(rawText);
    if (!seenPreprompt) {
      const { preprompt, rest } = extractPreprompt(body);
      if (preprompt) {
        seenPreprompt = true;
        events.push({ kind: "preprompt", at: ts, text: preprompt });
        body = rest;
      }
    }
    body = unwrapRelayEnvelopes(body);
    const { messages, rest: afterTeammates } = extractTeammateMessages(body);
    for (const msg of messages) {
      events.push({
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
    const remaining = extractTaskNotifications(body, ts, events);
    if (remaining.length > 0) {
      await pushTextWithImages(remaining, ts, events, promptUuid, readImage);
    }
  };

  for (const obj of parsed) {
    // Skip lines on an abandoned rewind branch — they are not part of the
    // live conversation. Lines without a uuid (metadata markers) are not in
    // the tree and always pass through.
    const uuid = typeof obj.uuid === "string" ? obj.uuid : null;
    if (uuid && !keptUuids.has(uuid)) continue;
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : null;
    // `JsonlEvent.at` must be a parseable instant for every consumer — a
    // string that fails Date.parse (NaN) would make comparisons against it
    // silently false rather than loudly wrong, so drop the line here instead
    // of downstream.
    if (!ts || Number.isNaN(Date.parse(ts))) continue;

    const type = obj.type;
    if (compaction && type !== "attachment" && obj.isCompactSummary !== true) {
      compaction = null;
    }
    const msg = obj.message as
      | {
          role?: string;
          content?: unknown;
          id?: string;
          model?: string;
          stop_reason?: string;
        }
      | undefined;

    if (type === "user" && obj.isCompactSummary === true) {
      // The summary the agent continues from — written by the harness, never
      // a message the user sent. A summary with no boundary before it still
      // folds into a compaction of its own.
      if (!compaction) {
        compaction = { kind: "compaction", at: ts, files: [] };
        events.push(compaction);
      }
      const summary = extractText(msg?.content)
        .replace(COMPACT_SUMMARY_PREAMBLE, "")
        .replace(COMPACT_SUMMARY_POSTSCRIPT, "")
        .trim();
      if (summary) compaction.summary = summary;
      continue;
    }

    if (type === "user" && msg?.role === "user") {
      const isMeta = obj.isMeta === true;
      const sourceToolUseID =
        typeof obj.sourceToolUseID === "string" ? obj.sourceToolUseID : null;
      if (isMeta && sourceToolUseID) {
        const linked = toolCallByUseId.get(sourceToolUseID);
        if (linked) {
          const text = extractText(msg.content);
          if (text) {
            linked.injectedContext = [...(linked.injectedContext ?? []), text];
          }
          continue;
        }
      }

      if (isMeta) {
        // Harness-injected prompt (loop/queue wakeup, resume, local-command
        // caveat) with no originating tool call. Surface it as its own kind so
        // it never renders as a human-authored user message.
        const text = extractText(msg.content);
        if (text) {
          events.push({
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
        await processUserText(content, ts, promptUuid);
      } else if (Array.isArray(content)) {
        const questionAnswer = extractQuestionAnswer(
          obj,
          (content as RawBlock[]).filter(
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
            (b) => b?.type === "tool_result",
          ).length,
        );
        const sessionEnded = obj.toolDenialKind === "interrupted";
        if (sessionEnded && uuid) sessionEndedResultLines.add(uuid);
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
              questionAnswer,
            };
            const existing = toolCallByUseId.get(toolUseId);
            if (existing) {
              existing.result = result;
            } else {
              pendingResults.push({ toolUseId, result });
            }
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
          } else if (block?.type === "text" && typeof block.text === "string") {
            await processUserText(block.text, ts, promptUuid);
          } else if (
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
            block?.type === "image" &&
            block.source?.type === "ref" &&
            typeof block.source.data === "string"
          ) {
            // `TranscriptLines` put the image's key where its bytes were.
            events.push({
              kind: "user-image",
              at: ts,
              image: {
                key: block.source.data,
                mime:
                  typeof block.source.media_type === "string"
                    ? block.source.media_type
                    : "image/jpeg",
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
        sessionEndedResultLines.has(obj.parentUuid)
      ) {
        continue;
      }
      if (obj.isApiErrorMessage === true) {
        events.push({
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
        !!lineUsage && !!msgId && !usageAttributedMsgIds.has(msgId);
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
          if (usageAnchor === event) event.usage = lineUsage;
          return;
        }
        usageAnchor = event;
        event.usage = lineUsage;
        usageAttributedMsgIds.add(msgId);
      };
      for (const block of msg.content as RawBlock[]) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
        if (block?.type === "thinking" && typeof block.thinking === "string") {
          events.push({
            kind: "assistant-thinking",
            at: ts,
            messageId: msgId,
            thinking: block.thinking,
          });
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; JSON array may contain null/undefined elements
        } else if (block?.type === "text" && typeof block.text === "string") {
          if (msgId) {
            const existing = assistantTextByMsgId.get(msgId);
            if (existing) {
              existing.text += block.text;
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
          if (msgId) assistantTextByMsgId.set(msgId, event);
          setUsageOnce(event);
          events.push(event);
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
          events.push(event);
          toolCallByUseId.set(toolUseId, event);
        }
      }
      if (msgId && msg.stop_reason) {
        const existing = assistantTextByMsgId.get(msgId);
        if (existing && !existing.stopReason) {
          existing.stopReason = msg.stop_reason;
        }
      }
      continue;
    }

    if (type === "system" && obj.subtype === "compact_boundary") {
      const meta = CompactMetadataSchema.safeParse(obj.compactMetadata);
      compaction = {
        kind: "compaction",
        at: ts,
        ...(meta.success ? meta.data : {}),
        files: [],
      };
      events.push(compaction);
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
      if (text) events.push({ kind: "system", at: ts, subtype, text });
      continue;
    }

    if (type === "summary") {
      const text =
        typeof (obj as { summary?: unknown }).summary === "string"
          ? (obj as { summary: string }).summary
          : "";
      if (text) events.push({ kind: "summary", at: ts, text });
      continue;
    }

    if (type === "attachment") {
      const att = obj.attachment;
      if (att && typeof att === "object") {
        const subtype =
          typeof (att as Record<string, unknown>).type === "string"
            ? ((att as Record<string, unknown>).type as string)
            : "unknown";
        if (compaction && COMPACTION_FILE_SUBTYPES.has(subtype)) {
          const file = compactionFile(att as Record<string, unknown>);
          if (file) {
            compaction.files.push(file);
            continue;
          }
        }
        events.push({ kind: "attachment", at: ts, subtype, attachment: att });
      }
      continue;
    }

    if (type === "queue-operation") {
      const operation =
        typeof obj.operation === "string" ? (obj.operation as string) : "";
      const content =
        typeof obj.content === "string" ? (obj.content as string) : undefined;
      if (!operation) continue;
      // A background-task completion is enqueued (and later dequeued) as a raw
      // <task-notification> block, then delivered again in the agent's next
      // user turn — three transcript lines for one event. Parse the block into
      // a structured task-notification here; the dedup pass below collapses all
      // copies into a single row. Plain queued prompts (no notification block)
      // keep their lightweight queue-op line ("Queued" / "Sent to agent").
      if (content && content.includes("<task-notification>")) {
        extractTaskNotifications(content, ts, events);
        continue;
      }
      // A prompt that never waited: its dequeue comes right after its enqueue,
      // with nothing the transcript shows in between. That is how a prompt
      // reaches an idle agent through the queue (every Agent SDK turn does), so
      // the pair is plumbing, not a parked prompt — the turn itself follows as
      // the user line. Only a prompt that sat in the queue while the agent
      // worked keeps its "Queued" / "Sent to agent" markers.
      const prev = events.at(-1);
      if (
        operation === "dequeue" &&
        prev?.kind === "queue-operation" &&
        prev.operation === "enqueue"
      ) {
        events.pop();
        continue;
      }
      events.push({ kind: "queue-operation", at: ts, operation, content });
      continue;
    }

    if (type === "file-history-delta") {
      const delta = FileHistoryDeltaSchema.safeParse(obj);
      if (delta.success) {
        const { trackingPath, backup } = delta.data;
        // `trackingPath` is worktree-relative for files inside the checkout and
        // absolute outside it; `realParentDir` is always the absolute directory.
        const name = trackingPath.slice(trackingPath.lastIndexOf("/") + 1);
        events.push({
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
        const last = lastRequestBySource.get(source);
        if (last && requestConfigChanges(last.config, config).length === 0) {
          last.calls += 1;
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
        lastRequestBySource.set(source, event);
        events.push(event);
        continue;
      }
    }

    if (type === "api-request-shape") {
      const shape = requestShapeOf(obj);
      if (shape) {
        const change = lastShape ? requestShapeChange(lastShape, shape) : null;
        lastShape = shape;
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
        events.push({ kind: "request-shape", at: ts, shape, change });
        continue;
      }
    }

    events.push({
      kind: "unknown",
      at: ts,
      type: typeof type === "string" ? type : "unknown",
      raw: obj,
    });
  }

  // Second pass: resolve deferred results that arrived before their call
  // (shouldn't happen in normal flow, but handle gracefully)
  for (const { toolUseId, result } of pendingResults) {
    const call = toolCallByUseId.get(toolUseId);
    if (call) {
      call.result = result;
    } else {
      // Orphan result — no matching call; emit as a tool-call with empty name
      events.push({
        kind: "tool-call",
        at: result.at,
        toolUseId,
        name: "",
        input: null,
        result,
      });
    }
  }

  // Background-task completions surface up to three times in the raw transcript
  // (queue enqueue at completion, dequeue when sent, delivered copy in the next
  // user turn) — all parse to the same task-notification. Collapse to one row,
  // keeping the earliest (completion time). Keyed by tool-use id when present,
  // else by the notification's identifying fields.
  const seenNotifications = new Set<string>();
  const deduped: JsonlEvent[] = [];
  for (const ev of events) {
    if (ev.kind === "task-notification") {
      const key =
        ev.toolUseId ??
        `${ev.taskId}|${ev.status}|${ev.summary}|${ev.outputFile ?? ""}`;
      if (seenNotifications.has(key)) continue;
      seenNotifications.add(key);
    }
    deduped.push(ev);
  }

  return deduped;
}
