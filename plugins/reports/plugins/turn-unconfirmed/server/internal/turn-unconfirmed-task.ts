import type { ReportRow } from "@plugins/reports/server";
import { TurnUnconfirmedPayloadSchema } from "../../core";
import type { TurnUnconfirmedPayload } from "../../core";

// Notification re-arm window: a conversation that keeps failing to confirm
// sent turns is a recurring delivery-path warning, not a one-shot crash — so
// it resurfaces occasionally (every 6h) rather than once-forever. Same policy
// as optimistic-divergence. Lives here (not the barrel) per barrel-purity.
export const TURN_UNCONFIRMED_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function payloadOf(row: ReportRow): TurnUnconfirmedPayload {
  // The row's data was validated by TurnUnconfirmedPayloadSchema at ingest, so
  // this is a total parse; failure would be a corrupted row (surfaced loudly).
  return TurnUnconfirmedPayloadSchema.parse(row.data);
}

export function renderTurnUnconfirmedTask(row: ReportRow): {
  title: string;
  description: string;
} {
  return { title: renderTitle(row), description: renderDescription(row) };
}

function renderTitle(row: ReportRow): string {
  const data = payloadOf(row);
  const noisePrefix = row.noise ? "[noise] " : "";
  const raw = `${noisePrefix}[turn-unconfirmed] turn not confirmed in transcript — ${data.conversationId} ("${data.textPreview}")`;
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

function renderDescription(row: ReportRow): string {
  const data = payloadOf(row);
  const lines: string[] = [];

  lines.push(
    `A sent turn was **never confirmed in the transcript**. The pending-turn state machine POSTed the user's message for conversation \`${data.conversationId}\`, the server acked it (2xx) — but after ${Math.round(data.elapsedMs / 1000)}s the message text never appeared in the conversation's transcript, so the turn entered the \`unconfirmed\` state. The user's text is safe (kept on the pending-turn card with a Retry affordance), but the agent very likely **never received the message** — the silent dropped-turn symptom this report exists to catch.`,
  );
  lines.push("");
  lines.push(`**What it means**`);
  lines.push(
    `The POST → agent process → transcript pipeline dropped the turn after the ack: usually an agent process that was not ready to take it, a wedged agent process, or a transcript/reconcile mismatch (the disk transcript rewrote the text in a way reconciliation could not match). A recurring report on the same conversation means that conversation's delivery path is systematically broken, not a one-off race.`,
  );
  lines.push("");
  lines.push(`**Unconfirmed turn**`);
  lines.push(`- **Conversation:** \`${data.conversationId}\``);
  lines.push(`- **Text preview:** \`${data.textPreview}\``);
  lines.push(
    `- **Elapsed:** ${Math.round(data.elapsedMs / 1000)}s from POST ack to the unconfirmed verdict`,
  );
  lines.push("");
  lines.push(`**Report**`);
  lines.push(`- **Source:** ${row.source}`);
  lines.push(`- **Worktree:** ${row.worktree}`);
  lines.push(`- **Fingerprint:** ${row.fingerprint}`);
  lines.push(`- **Count:** ${row.count}`);
  lines.push(`- **First seen:** ${row.firstSeenAt.toISOString()}`);
  lines.push(`- **Last seen:** ${row.lastSeenAt.toISOString()}`);
  if (row.url) lines.push(`- **URL:** ${row.url}`);
  if (row.userAgent) lines.push(`- **User-Agent:** ${row.userAgent}`);
  lines.push("");
  lines.push(`**How to fix**`);
  lines.push(
    `Open conversation \`${data.conversationId}\` and compare the transcript on disk with what the send endpoint claims it delivered: did the text reach the agent session at all (check the agent's \`agent.log\`, beside its \`events.jsonl\` in the \`state/sdk-agents/<namespace>/<conversationId>/\` data dir), or did it land but in a rewritten form the pending-turn reconciler failed to match (compare against the endpoint's \`resolvedText\`)? If the count keeps growing on this conversation, the delivery path is systematically broken — inspect the sdk runtime's delivery to the agent process and the conversation's session state rather than the reconciler. A rare, isolated report is the race the Retry affordance already covers.`,
  );
  return lines.join("\n");
}
