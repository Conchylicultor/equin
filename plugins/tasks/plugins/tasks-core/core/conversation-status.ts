import { z } from "zod";

export const ConversationStatusSchema = z.enum([
  "starting", // process spawning / worktree warming
  "working", // Claude is computing
  "waiting", // Claude paused for user / permission prompt
  "gone", // process dead, not user-completed — still resumable
  "done", // user explicitly closed
]);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

/**
 * What a `working` conversation's agent is busy with — set exactly while the
 * status is `working`, null otherwise (the mutation layer keeps the two
 * together). `working` itself means "busy without the user"; this says whether
 * a turn is running (what Stop interrupts, what a sent message queues behind)
 * or only background work the agent left running between turns (a backgrounded
 * build, a background subagent), which re-invokes it when it finishes.
 */
export const ConversationWorkingOnSchema = z.enum([
  "turn", // a turn is running
  "background", // between turns, background tasks pending
]);
export type ConversationWorkingOn = z.infer<typeof ConversationWorkingOnSchema>;
