import { z } from "zod";

/**
 * The jsonb payload for a `conversation-foreign-session` report: a session id
 * sitting in one conversation's chain that demonstrably belongs to another.
 *
 * Two arms, because there are two independent ways to see the same corruption
 * and they know different things:
 *
 * - `directory-mismatch` — the read path resolved the id to a transcript in a
 *   different `~/.claude/projects/<dir>/` than the one anchoring this
 *   conversation. It knows both directories and nothing about the other
 *   conversation (a directory does not name its owner).
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
    /** The projects dir the conversation's first resolvable session anchored. */
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
