import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { ResumeOutcomeSchema } from "@plugins/conversations/core";

// User opened (selected) the conversation: stamp lastViewedAt, which resets its
// idle-hibernation timer. Portable — a DB write any host serves.
export const markViewed = defineEndpoint({
  route: "POST /api/conversations/:id/viewed",
  response: z.object({ ok: z.literal(true) }),
});

// Transparently resume a HIBERNATED conversation the user opened, before they
// can type. Desktop-only: it respawns the agent session on this computer.
//
// The response is the resume outcome, not an `{ ok: true }` acknowledgement. The
// resume can legitimately fail (its worktree checkout was reclaimed while it
// slept) and this endpoint is the ONLY place that failure is observable — a
// response that could not express "blocked" meant a failed auto-resume looked
// identical to a successful one.
export const resumeHibernated = defineEndpoint({
  route: "POST /api/conversations/:id/resume-hibernated",
  response: ResumeOutcomeSchema,
  needsMachine: { feature: "Resuming a hibernated conversation" },
});
