import type { Guard, GuardContext, ToolMatcher, Verdict } from "./types";

export type Denial = DenialText &
  (
    | {
        /**
         * Escalate from "this call is denied" to "end the turn" (`continue: false`).
         * Costs the agent its in-flight context, so reserve it for a guard that has
         * already denied once and been ignored.
         */
        fatal?: boolean;
        allowOnRepeat?: never;
      }
    | {
        /**
         * Soften the denial to a warning: the same agent repeating the identical
         * call is let through (`DenyVerdict.allowOnRepeat`). For a guard whose
         * concern is cost, not correctness, where a deliberate caller may know
         * better. Drops the "STOP, do not work around" epilogue, which would
         * contradict it; the runner appends how to proceed.
         */
        allowOnRepeat: true;
        fatal?: never;
      }
  );

interface DenialText {
  /** Short statement of what was blocked */
  blocked: string;
  /** Why this is dangerous (optional background) */
  why?: string;
  /** What to do instead */
  hint: string;
  /** If true, skip the standard STOP/report epilogue */
  skipEpilogue?: boolean;
}

/** Let the call through while handing the model a fact it was missing. */
export interface Inform {
  inform: string;
}

/**
 * Let the call through with these fields of its input replaced, telling the
 * model why in `note` — or `null` when the change is plumbing it never needs to
 * know about (see `RewriteVerdict.note`).
 */
export interface Rewrite<I> {
  rewrite: Partial<I>;
  note: string | null;
}

export interface GuardDef<I> {
  name: string;
  matcher: ToolMatcher | ToolMatcher[];
  check(input: I, ctx: GuardContext): Denial | Inform | Rewrite<I> | null;
}

/**
 * Every hard denial also carries the bypass line (`bypassToProceed`, appended
 * by the runner), so this epilogue names both ways forward and forbids the
 * third: dodging the guard with a reshaped call.
 */
const EPILOGUE =
  "If you believe this block is a false positive: do NOT work around this guard — not by restructuring the command, not by using alternative tools, not by any other means. Either bypass it as below, if and only if you are sure this exact call is safe, or STOP and report the blocked command and your reasoning to the user.";

function formatDenyMessage(denial: Denial): string {
  let msg = denial.blocked;
  if (denial.why) msg += `\n\n${denial.why}`;
  msg += `\n\n${denial.hint}`;
  if (!denial.skipEpilogue && !denial.allowOnRepeat) msg += `\n\n${EPILOGUE}`;
  return msg;
}

export function defineGuard<I>(def: GuardDef<I>): Guard<I> {
  return {
    name: def.name,
    matcher: def.matcher,
    check(input: I, ctx: GuardContext): Verdict | Promise<Verdict> {
      const result = def.check(input, ctx);
      if (!result) return ctx.allow();
      if ("inform" in result) return ctx.inform(result.inform);
      if ("rewrite" in result) return ctx.rewrite(result.rewrite, result.note);
      const message = formatDenyMessage(result);
      if (result.allowOnRepeat) return ctx.warn(message);
      return result.fatal ? ctx.fatal(message) : ctx.deny(message);
    },
  };
}
