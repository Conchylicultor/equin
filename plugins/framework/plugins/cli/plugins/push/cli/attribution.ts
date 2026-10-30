import {
  ATTEMPT_TRAILER_KEY,
  PUSH_TRAILER_KEY,
  UNATTRIBUTED_TRAILER_KEY,
  attemptOfBranch,
} from "@plugins/tasks/plugins/tasks-core/core";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";

/**
 * Who a push credits — the trailers stamped on every commit it lands, beside
 * the push trailer.
 *
 * The conversation trailer is the prepare-commit-msg hook's, from
 * `EQUIN_CONVERSATION_ID`, which only a session equin launched carries. A push
 * from any other session (a plain `claude` in a terminal, the usual case while
 * recovering a broken main) is still credited, by what the checkout itself
 * says: an attempt's branch is `claude-web/<attemptId>`, so its commits are
 * stamped with the attempt trailer. That is derived, not delivered — a branch
 * cannot name another attempt the way an inherited env var named another
 * conversation.
 *
 * A checkout that is no attempt's, pushed from a session with no conversation,
 * names nobody: `--unattributed "<reason>"` says so on purpose, and is refused
 * whenever the push IS attributable, so it can never discard a real name.
 */
export type PushAttribution =
  { ok: true; trailers: string[] } | { ok: false; message: string };

export function resolvePushAttribution(input: {
  branch: string;
  pushId: string;
  /** `EQUIN_CONVERSATION_ID`, unset outside an equin-launched session. */
  conversationId: string | undefined;
  /** `--unattributed <reason>`. */
  unattributed: string | undefined;
}): PushAttribution {
  const trailers = [`${PUSH_TRAILER_KEY}=${input.pushId}`];
  const attemptId = attemptOfBranch(input.branch);
  if (attemptId) trailers.push(`${ATTEMPT_TRAILER_KEY}=${attemptId}`);

  if (input.unattributed === undefined) return { ok: true, trailers };

  const reason = input.unattributed.trim();
  if (input.conversationId) {
    return {
      ok: false,
      message:
        `--unattributed refused: this push is attributed to conversation ${input.conversationId} ` +
        `(${envName("CONVERSATION_ID")}). Drop the flag.`,
    };
  }
  if (attemptId) {
    return {
      ok: false,
      message:
        `--unattributed refused: this push is attributed to attempt ${attemptId}, ` +
        `named by its branch (${input.branch}). Drop the flag.`,
    };
  }
  if (!reason || /[\r\n]/.test(reason)) {
    return {
      ok: false,
      message:
        '--unattributed needs a one-line reason, e.g. --unattributed "recovery: main\'s server would not boot".',
    };
  }
  trailers.push(`${UNATTRIBUTED_TRAILER_KEY}=${reason}`);
  return { ok: true, trailers };
}

/** `--trailer` arguments for a `git commit` argv. */
export function trailerArgs(trailers: readonly string[]): string[] {
  return trailers.flatMap((t) => ["--trailer", t]);
}

/**
 * The amend a rebase `--exec` runs after each replayed commit: one shell
 * string, so every trailer (an `--unattributed` reason is free text) is
 * single-quoted.
 */
export function trailerAmendCommand(trailers: readonly string[]): string {
  const quoted = trailers.map((t) => `--trailer '${t.replace(/'/g, `'\\''`)}'`);
  return `git -c trailer.ifexists=replace commit --amend --no-edit ${quoted.join(" ")}`;
}
