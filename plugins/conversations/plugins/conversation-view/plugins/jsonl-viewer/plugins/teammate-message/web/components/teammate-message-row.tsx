import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { Avatar } from "@plugins/primitives/plugins/avatar/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { AttemptChip } from "@plugins/active-data/plugins/attempt/web";
import { attemptIdKind } from "@plugins/tasks/plugins/task-ids/core";

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

type PeerSession = NonNullable<TeammateMessageEvent["session"]>;

/** The attempt an equin agent's session is named after: its session name is
 *  the attempt id, possibly with a suffix (`att-…-5k4w8f-da`). */
function attemptOfSession(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const match = attemptIdKind.pattern.exec(name);
  return match?.index === 0 ? match[0] : undefined;
}

function sessionNote(session: PeerSession): string | undefined {
  const parts = [
    session.mode,
    session.hops > 1 ? `relayed by ${session.hops} sessions` : undefined,
  ].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? `· ${parts.join(" · ")}` : undefined;
}

function MessageBody({ body }: { body: string }) {
  const status = statusLine(body);
  return status ? (
    <Text as="div" variant="caption" className="text-muted-foreground">
      {status}
    </Text>
  ) : (
    <Text
      as="div"
      variant="caption"
      className="break-words text-muted-foreground"
    >
      <Markdown>{body}</Markdown>
    </Text>
  );
}

/** A message another Claude session sent over the cross-session channel: who
 *  sent it — the task it works on, when it is one of the app's agents, opening
 *  its conversation — and what it wrote, shown open since the agent acts on it. */
function CrossSessionMessageRow({
  session,
  body,
}: {
  session: PeerSession;
  body: string;
}) {
  const attemptId = attemptOfSession(session.name);
  return (
    <CollapsibleCard
      icon={
        <Avatar
          fallbackKey={session.name}
          fallbackGlyph={session.name?.[0] ?? "?"}
        />
      }
      label={
        attemptId !== undefined || session.name === undefined
          ? "Message from another session"
          : `Message from ${session.name}`
      }
      aside={
        attemptId !== undefined ? (
          <AttemptChip content={attemptId} attrs={{}} />
        ) : undefined
      }
      note={sessionNote(session)}
      defaultOpen
    >
      <MessageBody body={body} />
    </CollapsibleCard>
  );
}

export function TeammateMessageRow({ event }: { event: JsonlEvent }) {
  const e = event as TeammateMessageEvent;
  if (e.session)
    return <CrossSessionMessageRow session={e.session} body={e.body} />;

  // An INBOUND peer message from another Claude session — visually distinct from
  // the solid human user bubble. The teammate `color` attr ("yellow"/"blue"/…)
  // is not an avatar color key, so we let the deterministic auto-color (keyed on
  // teammateId) pick a stable disc color instead.
  const label = e.teammateId ?? "Teammate";

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
      <MessageBody body={e.body} />
    </CollapsibleCard>
  );
}
