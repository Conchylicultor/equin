import type { Guard, GuardContext, ToolMatcher, Verdict } from "./types";

export interface Denial {
  /** Short statement of what was blocked */
  blocked: string;
  /** Why this is dangerous (optional background) */
  why?: string;
  /** What to do instead */
  hint: string;
  /** If true, skip the standard STOP/report epilogue */
  skipEpilogue?: boolean;
  /**
   * Escalate from "this call is denied" to "end the turn" (`continue: false`).
   * Costs the agent its in-flight context, so reserve it for a guard that has
   * already denied once and been ignored.
   */
  fatal?: boolean;
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
  /** File token checked via ctx.hasBypass() before check() runs */
  bypassToken?: string;
  check(input: I, ctx: GuardContext): Denial | Inform | Rewrite<I> | null;
}

function formatEpilogue(bypassToken?: string): string {
  let epilogue =
    "If you believe this block is a false positive: STOP immediately, report the blocked command and your reasoning to the user, and wait for instructions. Do NOT attempt to work around this guard — not by restructuring the command, not by using alternative tools, not by any other means.";
  if (bypassToken) {
    epilogue += ` If the user explicitly approves, they will tell you to create ${bypassToken} at the root of your checkout (not the current directory) to bypass.`;
  }
  return epilogue;
}

function formatDenyMessage(denial: Denial, bypassToken?: string): string {
  let msg = denial.blocked;
  if (denial.why) msg += `\n\n${denial.why}`;
  msg += `\n\n${denial.hint}`;
  if (!denial.skipEpilogue) msg += `\n\n${formatEpilogue(bypassToken)}`;
  return msg;
}

export function defineGuard<I>(def: GuardDef<I>): Guard<I> {
  return {
    name: def.name,
    matcher: def.matcher,
    ...(def.bypassToken ? { bypassToken: def.bypassToken } : {}),
    check(input: I, ctx: GuardContext): Verdict | Promise<Verdict> {
      if (def.bypassToken && ctx.hasBypass(def.bypassToken)) return ctx.allow();
      const result = def.check(input, ctx);
      if (!result) return ctx.allow();
      if ("inform" in result) return ctx.inform(result.inform);
      if ("rewrite" in result) return ctx.rewrite(result.rewrite, result.note);
      const message = formatDenyMessage(result, def.bypassToken);
      return result.fatal ? ctx.fatal(message) : ctx.deny(message);
    },
  };
}
