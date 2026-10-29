import { z } from "zod";
import { liveValue, patchValue } from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Signing in to Claude from the app: one sign-in at a time on this computer,
// run as Claude Code's own sign-in (the build the Agent SDK ships) and shown as
// the `claude-sign-in.flow` value. The user never runs a command.

/**
 * How the computer signs in to Claude Code — Claude Code's own three ways, as
 * data both halves read: the menu shows each `label` / `hint`, the machine
 * half turns the id into Claude Code's flag.
 */
export const CLAUDE_SIGN_IN_METHODS = {
  claudeai: {
    label: "Claude subscription",
    hint: "Pro, Max, Team or Enterprise",
  },
  console: {
    label: "Anthropic Console",
    hint: "Billed per use to an organization",
  },
  sso: { label: "Single sign-on", hint: "Your organization's SSO" },
} as const;
export type ClaudeSignInMethod = keyof typeof CLAUDE_SIGN_IN_METHODS;
export const ClaudeSignInMethodSchema = z.enum(
  Object.keys(CLAUDE_SIGN_IN_METHODS) as [
    ClaudeSignInMethod,
    ...ClaudeSignInMethod[],
  ],
);

/**
 * What a sign-in is for.
 *
 * - `computer` — the computer's own Claude Code login (the system account),
 *   in the way the user picked.
 * - `new-account` — another Claude account agents can run on, saved under
 *   `name` (`claude-cli/accounts`). Always a Claude subscription: the
 *   long-lived token an added account holds exists only for one (an API key is
 *   pasted instead), so a method has no spelling here.
 */
export const ClaudeSignInTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("computer"), method: ClaudeSignInMethodSchema }),
  z.object({ kind: z.literal("new-account"), name: z.string().trim().min(1) }),
]);
export type ClaudeSignInTarget = z.infer<typeof ClaudeSignInTargetSchema>;

/**
 * The computer's one sign-in, as it stands.
 *
 * - `idle` — none running (never started, cancelled, or dismissed).
 * - `waiting` — Claude Code waits for the browser. `url` is the page it asked
 *   to open (null until it has); `manualUrl` the page for another device,
 *   which shows a code to paste back (null until printed — a new account's
 *   sign-in never prints one).
 * - `done` — signed in: the computer's login works, or the account was added.
 * - `failed` — Claude Code said why, or the app could not finish it.
 *
 * `id` names one run, so a code or a cancel from a tab that saw an older run
 * cannot reach a newer one.
 */
export const ClaudeSignInFlowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }),
  z.object({
    kind: z.literal("waiting"),
    id: z.string(),
    target: ClaudeSignInTargetSchema,
    url: z.string().nullable(),
    manualUrl: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("done"),
    id: z.string(),
    target: ClaudeSignInTargetSchema,
    /** The added account's id, for a `new-account` sign-in. */
    accountId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("failed"),
    id: z.string(),
    target: ClaudeSignInTargetSchema,
    error: z.string(),
  }),
]);
export type ClaudeSignInFlow = z.infer<typeof ClaudeSignInFlowSchema>;

const NEEDS_MACHINE = { feature: "Signing in to Claude" } as const;

/**
 * The computer's sign-in, pushed on every step. It drives Claude Code on the
 * computer, so only the desktop app answers it.
 */
export const claudeSignInFlow = liveValue("claude-sign-in.flow", {
  schema: ClaudeSignInFlowSchema,
  needsMachine: NEEDS_MACHINE,
});

/**
 * Start a sign-in. One runs at a time on this computer: starting another
 * cancels the one running (the user asked again — a new method, Try again, an
 * account from another tab). Answers the new run's id.
 */
export const startClaudeSignIn = defineEndpoint({
  route: "POST /api/claude-sign-in/start",
  unpredicted: {
    reason: "server-decided",
    why: "the flow's state comes from Claude Code's own output, pushed through claude-sign-in.flow",
  },
  body: z.object({ target: ClaudeSignInTargetSchema }),
  response: z.object({ id: z.string() }),
  needsMachine: NEEDS_MACHINE,
});

/** The code the sign-in page showed on another device, handed to Claude Code. */
export const submitClaudeSignInCode = defineEndpoint({
  route: "POST /api/claude-sign-in/code",
  unpredicted: {
    reason: "precondition",
    why: "refused (409) unless that run is still waiting; what the code does is Claude Code's answer",
  },
  body: z.object({ id: z.string(), code: z.string().trim().min(1) }),
  needsMachine: NEEDS_MACHINE,
});

/** Stop the run `id` (or dismiss its outcome): the flow reads idle again. */
export const cancelClaudeSignIn = defineEndpoint({
  route: "POST /api/claude-sign-in/cancel",
  effect: (on) =>
    patchValue(
      on,
      claudeSignInFlow,
      () => ({}),
      (flow, { body }) =>
        flow.kind !== "idle" && flow.id === body.id ? { kind: "idle" } : flow,
    ),
  body: z.object({ id: z.string() }),
  needsMachine: NEEDS_MACHINE,
});
