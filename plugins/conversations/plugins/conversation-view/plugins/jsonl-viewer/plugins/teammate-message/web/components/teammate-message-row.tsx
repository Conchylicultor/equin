import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { Avatar } from "@plugins/primitives/plugins/avatar/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

type TeammateMessageEvent = Extract<JsonlEvent, { kind: "teammate-message" }>;

/** Detect a status/idle JSON notification body and summarize it in one line.
 *  Returns null for ordinary (markdown report) bodies so they render as
 *  markdown instead. */
function statusLine(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    // A non-JSON body is the common case (markdown reports) — fall through to
    // markdown rendering. Only JSON.parse's own SyntaxError is expected here.
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
  if (parsed == null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== "string") return null;
  const detail =
    typeof obj.idleReason === "string"
      ? obj.idleReason
      : typeof obj.reason === "string"
        ? obj.reason
        : typeof obj.status === "string"
          ? obj.status
          : null;
  if (obj.type === "idle_notification") {
    return detail ? `Idle — ${detail}` : "Idle";
  }
  return detail ? `${obj.type} — ${detail}` : obj.type;
}

export function TeammateMessageRow({ event }: { event: JsonlEvent }) {
  const e = event as TeammateMessageEvent;

  // An INBOUND peer message from another Claude session — visually distinct from
  // the solid human user bubble. The teammate `color` attr ("yellow"/"blue"/…)
  // is not an avatar color key, so we let the deterministic auto-color (keyed on
  // teammateId) pick a stable disc color instead.
  const label = e.teammateId ?? "Teammate";
  const status = statusLine(e.body);

  return (
    <CollapsibleCard
      icon={
        <Avatar
          fallbackKey={e.teammateId}
          fallbackGlyph={e.teammateId?.[0] ?? "?"}
        />
      }
      label={label}
      note={e.summary ? `· ${e.summary}` : undefined}
    >
      {status ? (
        <Text as="div" variant="caption" className="text-muted-foreground">
          {status}
        </Text>
      ) : (
        <Text as="div" variant="caption" className="break-words text-muted-foreground">
          <Markdown>{e.body}</Markdown>
        </Text>
      )}
    </CollapsibleCard>
  );
}
