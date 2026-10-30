import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Manual "connect / sync now" trigger. POST with no body — `ensureAccount()`
// arms the engine and, when already in delta, enqueues an immediate delta. Used
// by the phase-3 UI and for worktree testing (the scheduled tick is main-only).
export const mailSyncEndpoint = defineEndpoint({
  route: "POST /api/mail/sync",
  response: z.object({ accountId: z.string(), status: z.string() }),
});

// Ask again for one message's body — the Retry of a failed fetch. A write, not
// a read: it enqueues the `mail.hydrate` job (deduped per message), whose
// result reaches the reader through the `mail.message-body` live value. A
// subscriber to that value already asks once on its own; this is for a reader
// still holding a failed answer. `queued` is false when the body is cached
// already or the message is not in the mirror (nothing to fetch).
export const mailHydrateMessageEndpoint = defineEndpoint({
  route: "POST /api/mail/hydrate",
  body: z.object({ messageId: z.string() }),
  response: z.object({ queued: z.boolean() }),
});
