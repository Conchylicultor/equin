import type { SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import { withDeadline } from "@plugins/packages/plugins/deadline/core";
import { claudeQuery, type ClaudeSessionEnv } from "./session";

/** The session never answered its `initialize`: a hung or crashed CLI. */
export class ClaudeInitializeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Claude Code did not answer initialize within ${timeoutMs / 1000}s`);
    this.name = "ClaudeInitializeTimeoutError";
  }
}

/**
 * What Claude Code says about itself, without a turn: one session that sends
 * no prompt, waits for its `initialize` answer (the version, the signed-in
 * account, the model menu) and closes. Answered locally — no model call,
 * nothing billed. ~1–3 s of CLI start-up.
 *
 * `settingSources: ["user"]`, so the menu honours the user's own settings and
 * env overrides, as an agent's does; no MCP server loads.
 */
export async function readClaudeInitialize({
  env,
  bin,
  cwd,
  timeoutMs,
  signal,
}: {
  env: ClaudeSessionEnv;
  bin: string;
  /** Where the session runs — a scratch directory (nothing there is read). */
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<SDKControlInitializeResponse> {
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  // Streaming input that never yields: the session stays open for control
  // requests and no turn is ever sent.
  async function* noPrompt(): AsyncGenerator<never> {
    await released;
  }
  const session = claudeQuery({
    env,
    bin,
    prompt: noPrompt(),
    options: {
      cwd,
      settingSources: ["user"],
      strictMcpConfig: true,
      persistSession: false,
      abortController,
    },
  });
  try {
    return await withDeadline(
      session.initializationResult(),
      timeoutMs,
      () => new ClaudeInitializeTimeoutError(timeoutMs),
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    release();
    session.close();
  }
}
