import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";

/**
 * A guard bypass, spelled once: the denied call's id, the command that lets it
 * through, and the parser both the hook and the CLI read it with.
 *
 * The id binds the bypass to ONE call — the guard that refused it and a hash of
 * the call exactly as that guard judged it — so a bypass can neither be granted
 * ahead of a denial nor reused for a different call.
 */

/** Below this the reason is a shrug, not a judgement — refused by both readers. */
export const BYPASS_MIN_REASON = 20;

/** `<guard>#<hash>`. A guard name holds no `#` or whitespace. */
const ID_RE = /^([^\s#]+)#([0-9a-z]+)$/;

/** The bypass id of a call `guard` refused, from its repeat key's hash. */
export function bypassId(guard: string, hash: string): string {
  return `${guard}#${hash}`;
}

/** The command a denial tells the agent to run, the reason left for it to write. */
export function bypassCommand(id: string): string {
  return `./${CLI_NAME} guard bypass ${id} --reason "<why this exact call is safe>"`;
}

export interface BypassRequest {
  id: string;
  guard: string;
  reason: string;
}

export type BypassParse =
  { ok: true; request: BypassRequest } | { ok: false; why: string };

/** Whether a CLI call's args (after the CLI name) are the bypass verb at all. */
export function isBypassCall(args: readonly string[]): boolean {
  return args[0] === "guard" && args[1] === "bypass";
}

/**
 * The args after the CLI name: `guard bypass <id> --reason <text>` (or
 * `--reason=<text>`), nothing else.
 */
export function parseBypassArgs(args: readonly string[]): BypassParse {
  if (!isBypassCall(args))
    return { ok: false, why: "not a `guard bypass` call" };
  let id: string | undefined;
  let reason: string | undefined;
  const rest = args.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--reason") {
      reason = rest[++i];
    } else if (a.startsWith("--reason=")) {
      reason = a.slice("--reason=".length);
    } else if (id === undefined && !a.startsWith("-")) {
      id = a;
    } else {
      return { ok: false, why: `unexpected argument \`${a}\`` };
    }
  }
  if (id === undefined)
    return { ok: false, why: "missing the bypass id the denial named" };
  const m = ID_RE.exec(id);
  if (!m)
    return {
      ok: false,
      why: `\`${id}\` is not a bypass id (\`<guard>#<hash>\`, as the denial printed it)`,
    };
  const text = reason?.trim() ?? "";
  if (text.length < BYPASS_MIN_REASON)
    return {
      ok: false,
      why: `--reason must say why this exact call is safe (at least ${BYPASS_MIN_REASON} characters)`,
    };
  return { ok: true, request: { id, guard: m[1]!, reason: text } };
}
