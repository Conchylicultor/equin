import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { ApiErrorRow } from "../../web/components/api-error-row";

// Texts as the CLI writes them (taken from real transcripts).
const USAGE_LIMIT: JsonlEvent = {
  kind: "api-error",
  at: "2026-10-20T16:20:00.000Z",
  error: "rate_limit",
  text: "You've hit your session limit · resets 6:20pm (Europe/Paris)",
};

const SERVER_ERROR: JsonlEvent = {
  kind: "api-error",
  at: "2026-10-20T16:21:00.000Z",
  error: "server_error",
  text: "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.",
};

export default function ApiErrorRowsExhibit() {
  return (
    <div>
      <ApiErrorRow event={USAGE_LIMIT} />
      <ApiErrorRow event={SERVER_ERROR} />
    </div>
  );
}
