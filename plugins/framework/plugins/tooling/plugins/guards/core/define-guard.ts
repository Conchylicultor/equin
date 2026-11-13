import type { BypassToken } from "@plugins/framework/plugins/tooling/plugins/guards/plugins/bypass-tokens/core";
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
  /** File token checked via ctx.hasBypass() before check() runs */
  bypassToken?: BypassToken;
  check(input: I, ctx: GuardContext): Denial | Inform | Rewrite<I> | null;
}

/**
 * A guard judges a call before any of it runs, so a bypass file created inside
 * the blocked call itself (`touch .allow-x && psql …`) comes too late — the
 * call is refused again. The epilogue says so, and names the exact file.
 */
function formatEpilogue(bypassPath: string | null): string {
  let epilogue =
    "If you believe this block is a false positive: STOP immediately, report the blocked command and your reasoning to the user, and wait for instructions. Do NOT attempt to work around this guard — not by restructuring the command, not by using alternative tools, not by any other means.";
  if (bypassPath !== null) {
    epilogue += ` If the user explicitly approves, they will tell you to create the bypass file at the root of your checkout (not the current directory): run \`touch ${bypassPath}\` as its OWN tool call first, then retry the command unchanged. The guard checks for the file before any part of a call runs, so a \`touch\` chained into the blocked command itself comes too late and is blocked again.`;
  }
  return epilogue;
}

function formatDenyMessage(denial: Denial, bypassPath: string | null): string {
  let msg = denial.blocked;
  if (denial.why) msg += `\n\n${denial.why}`;
  msg += `\n\n${denial.hint}`;
  if (!denial.skipEpilogue && !denial.allowOnRepeat)
    msg += `\n\n${formatEpilogue(bypassPath)}`;
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
      const message = formatDenyMessage(
        result,
        def.bypassToken ? ctx.bypassPath(def.bypassToken) : null,
      );
      if (result.allowOnRepeat) return ctx.warn(message);
      return result.fatal ? ctx.fatal(message) : ctx.deny(message);
    },
  };
}
