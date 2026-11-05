import { z } from "zod";

/**
 * The jsonb payload for a `conversation-foreign-session` report: a session id
 * offered to, or sitting in, one conversation's chain that demonstrably belongs
 * to another.
 *
 * Two arms, because there are two independent ways to see the same corruption
 * and they know different things:
 *
 * - `directory-mismatch` — the id's transcript was written in a different
 *   `~/.claude/projects/<dir>/` than the one this conversation's working
 *   directory names (the status reconciler sees it when the session the runtime
 *   offered it is born; it then refuses the id). It knows both directories and
 *   nothing about the other conversation (a directory does not name its owner).
 * - `shared-session-id` — a pure-SQL detector found one `claude_session_id` in
 *   two conversations' chains. It knows exactly who else holds the id and
 *   touches no filesystem at all, so it works for hibernated conversations
 *   whose transcripts are long gone.
 *
 * A flat schema would force each arm to fabricate the other's fields. The union
 * makes that unspellable: whichever detector files, it can only supply what it
 * actually observed.
 *
 * Fingerprinted per `(conversationId, foreignSessionId)` — the unit of repair is
 * one chain row, and the answer is always the same: remove it.
 */
export const ForeignSessionPayloadSchema = z.discriminatedUnion("reason", [
  z.object({
    reason: z.literal("directory-mismatch"),
    conversationId: z.string(),
    foreignSessionId: z.string(),
    /** The projects dir the foreign id's transcript actually lives in. */
    foreignDir: z.string(),
    /** The projects dir this conversation's working directory names. */
    anchorDir: z.string(),
  }),
  z.object({
    reason: z.literal("shared-session-id"),
    conversationId: z.string(),
    foreignSessionId: z.string(),
    /** The other conversations whose chains hold the same id. Never empty. */
    otherConversationIds: z.array(z.string()).min(1),
  }),
]);

export type ForeignSessionPayload = z.infer<typeof ForeignSessionPayloadSchema>;
