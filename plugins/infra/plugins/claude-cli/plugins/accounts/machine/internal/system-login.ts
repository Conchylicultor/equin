import { z } from "zod";
import { CLAUDE_USER_CONFIG } from "@plugins/infra/plugins/paths/core";
import { readFile, stat } from "@plugins/packages/plugins/timed-fs/core";

// Which Claude account the system account is now: the claude.ai login the
// computer's Claude Code is signed into, as Claude Code records it in its
// user config (`~/.claude.json`'s `oauthAccount`). The same `accountUuid` a
// transcript's `session-owner` record names, so a session the computer's
// login ran can be told apart from one another login ran.

/** The computer's Claude Code login: its account uuid, or none (signed out, or signed in with an API key). */
export type SystemLogin =
  { kind: "signed-in"; accountUuid: string } | { kind: "none" };

const UserConfigLoginSchema = z.object({
  oauthAccount: z
    .object({ accountUuid: z.string().min(1).optional() })
    .passthrough()
    .optional(),
});

/** The login `text` (the user config's contents) names. Throws on a file that is not JSON. */
export function systemLoginOf(text: string): SystemLogin {
  const parsed = UserConfigLoginSchema.safeParse(JSON.parse(text));
  const accountUuid = parsed.success
    ? parsed.data.oauthAccount?.accountUuid
    : undefined;
  return accountUuid === undefined
    ? { kind: "none" }
    : { kind: "signed-in", accountUuid };
}

/** The last read, keyed by the file's mtime and size — the file is megabytes, read on every live usage pass. */
let last: { mtimeMs: number; size: number; login: SystemLogin } | null = null;

/**
 * The computer's Claude Code login now. Re-read only when the user config
 * changed since the last read (its mtime or size moved). No user config: none.
 */
export async function readSystemLogin(): Promise<SystemLogin> {
  let st;
  try {
    st = await stat(CLAUDE_USER_CONFIG);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "none" };
    throw err;
  }
  if (last !== null && last.mtimeMs === st.mtimeMs && last.size === st.size)
    return last.login;
  const text = await readFile(CLAUDE_USER_CONFIG, "utf8");
  let login: SystemLogin;
  try {
    login = systemLoginOf(text);
  } catch (err) {
    // Claude Code rewrites this file often; a read that met its write half
    // done is not JSON. Read again only when the file moved since the stat —
    // an unchanged file that is not JSON is a real fault, thrown.
    if (!(err instanceof SyntaxError)) throw err;
    const again = await stat(CLAUDE_USER_CONFIG);
    if (again.mtimeMs === st.mtimeMs && again.size === st.size) throw err;
    return readSystemLogin();
  }
  last = { mtimeMs: st.mtimeMs, size: st.size, login };
  return login;
}
