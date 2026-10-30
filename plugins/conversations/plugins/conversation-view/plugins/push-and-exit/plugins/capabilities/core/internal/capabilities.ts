import { z } from "zod";
import { defineCapability } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * What an agent may do with its finished work.
 *
 * - `never` — stop at a ready branch and raise a flag; a person pushes.
 * - `safe` — push only an uncontroversial change (small, local, no behaviour or
 *   API a person relies on, no design choice); otherwise stop and flag what
 *   needs a decision.
 * - `checks` — push as soon as every check passes.
 */
export const PUSH_POLICIES = ["never", "safe", "checks"] as const;
export const PushPolicySchema = z.enum(PUSH_POLICIES);
export type PushPolicy = z.infer<typeof PushPolicySchema>;
export const PUSH_POLICY_LABELS: Record<PushPolicy, string> = {
  never: "Never",
  safe: "If uncontroversial",
  checks: "When checks pass",
};

/** The instruction each push policy becomes — in an automation's prompt
 * (`{{pushPolicy}}`) and in the mandate instructions alike. */
export const PUSH_POLICY_TEXT: Record<PushPolicy, string> = {
  never:
    "Do NOT push. When the build is `ok`, stop and raise a flag so a person reviews the branch — say what changed and why.",
  safe: 'Push with `./equin push -m "…"` ONLY if the change is uncontroversial: small and local, no behaviour or API a person relies on changes, no design choice is left to make, and every check passes. **You are authorized to push such a change without asking.** Anything else: do NOT push — raise a flag that says what needs a decision.',
  checks:
    '**You are authorized to push this task\'s change without asking** once every check passes and the build is `ok`: `./equin push -m "…"`.',
};

/**
 * A mandate's push policy: an automation's three, plus `on-request` — the
 * policy of a task a person drives, who says when to push. Not an automation
 * option: an automation runs with nobody there to ask.
 */
export const MANDATE_PUSH_POLICIES = ["on-request", ...PUSH_POLICIES] as const;
export const MandatePushPolicySchema = z.enum(MANDATE_PUSH_POLICIES);
export type MandatePushPolicy = z.infer<typeof MandatePushPolicySchema>;

/** The instruction each mandate push policy becomes in the mandate
 * instructions. */
export const MANDATE_PUSH_POLICY_TEXT: Record<MandatePushPolicy, string> = {
  "on-request":
    'Push only when the user asks you to, with `./equin push -m "…"` — never on your own initiative.',
  ...PUSH_POLICY_TEXT,
};

/** What the agent may do with its finished work (instructions only). */
export const pushPolicy = defineCapability<MandatePushPolicy>({
  id: "push.policy",
  schema: MandatePushPolicySchema,
  label: "Push policy",
});

/**
 * When the agent closes its own conversation with `exit_clean` — a tool every
 * conversation has; this says when to call it (instructions only).
 *
 * - `on-request` — once a person asks it to wrap up (a task a person drives,
 *   or an automation whose report a person reviews in the open conversation).
 * - `when-done` — on its own, as soon as its work is complete (its outcome
 *   report submitted, when one is required): a supervisor's worker, whose
 *   reviewer is the supervisor — a `message_agent` resumes a closed one.
 */
export const EXIT_WHENS = ["on-request", "when-done"] as const;
export const ExitWhenSchema = z.enum(EXIT_WHENS);
export type ExitWhen = z.infer<typeof ExitWhenSchema>;

/** The instruction each exit policy becomes in the mandate instructions. */
export const EXIT_WHEN_TEXT: Record<ExitWhen, string> = {
  "on-request":
    "When the user asks you to wrap up, you may close this conversation with `exit_clean` once your work landed and there is nothing they need to know. Never call it on your own: the conversation stays open for review.",
  "when-done":
    "Once your work is complete (your outcome report submitted, when your mandate requires one) and there is nothing left to do, close this conversation with `exit_clean` — do not wait to be asked. Whoever supervises you can still message you: that resumes you.",
};

/** When the agent closes its own conversation (`exit_clean`). */
export const exitClean = defineCapability<ExitWhen>({
  id: "exit.clean",
  schema: ExitWhenSchema,
  label: "Exit cleanly",
});

/** May raise a flag for a person's attention (`flag_raise`) — the agent's
 * channel to a human. */
export const flagRaise = defineCapability<true>({
  id: "flag.raise",
  schema: z.literal(true),
  label: "Raise a flag",
});
