import type { ClaudeSignInMethod, ClaudeSignInTarget } from "../../core";

// What Claude Code's sign-in commands are asked, and what their output means —
// pure, so the reading is pinned by tests and adjusted in one place when a new
// Claude Code build changes its wording.
//
// Observed with the bundled 2.1.310:
// - `auth login [--console|--sso]` (piped stdio, no TTY) prints, within
//   ~300 ms, "Opening browser to sign in…\nIf the browser didn't open, visit:
//   <URL>\nPaste code here if prompted > " — <URL> is the manual flow (its
//   page shows a code, read back on stdin). It also hands $BROWSER a second URL
//   whose localhost callback completes the sign-in by itself.
// - `setup-token` is a terminal UI only, so it runs under a pseudo-terminal
//   and is read from its screen (`screen.ts`). It hands $BROWSER its URL, then
//   draws "Browser didn't open? Use the url below to sign in" over the manual
//   URL. A refused code draws "OAuth error: …" over "Press Enter to retry."
//   and waits for Enter forever — the browser shows success either way, so
//   that prompt is the only sign the sign-in failed. On success it draws the
//   token and exits 0 on its own (after ~500 ms); the token is read as the
//   first `sk-ant-oat…` on the screen, and none is a failure.

const METHOD_FLAGS: Record<ClaudeSignInMethod, readonly string[]> = {
  claudeai: [],
  console: ["--console"],
  sso: ["--sso"],
};

/** Claude Code's arguments for a sign-in of `target`. */
export function signInArgs(target: ClaudeSignInTarget): string[] {
  switch (target.kind) {
    case "computer":
      return ["auth", "login", ...METHOD_FLAGS[target.method]];
    case "new-account":
      return ["setup-token"];
  }
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

function lines(output: string): string[] {
  return output
    .replace(ANSI, "")
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

const SETUP_TOKEN_MANUAL = /use the url below to sign in/i;

/**
 * The page for another device, or null before it is printed: `auth login`'s
 * "visit: <url>", or the URL `setup-token` draws below its "Use the url below
 * to sign in".
 */
export function parseManualUrl(output: string): string | null {
  const said = lines(output);
  for (const [i, line] of said.entries()) {
    const match = /visit:\s*(https:\/\/\S+)/.exec(line);
    if (match?.[1]) return match[1];
    const next = said[i + 1];
    if (SETUP_TOKEN_MANUAL.test(line) && next?.startsWith("https://"))
      return next.split(/\s/, 1)[0] ?? null;
  }
  return null;
}

/**
 * The sign-in page Claude Code handed `$BROWSER` (the shim appends one per
 * line), or null before it has. The latest one wins.
 */
export function parseBrowserUrl(handed: string): string | null {
  const urls = lines(handed).filter((l) => l.startsWith("https://"));
  return urls.at(-1) ?? null;
}

const TOKEN = /sk-ant-oat[A-Za-z0-9_-]+/;
const ANY_CREDENTIAL = /sk-ant-[A-Za-z0-9_-]+/g;

/** The long-lived token `setup-token` printed on success. */
export type SetupTokenOutput =
  { kind: "token"; token: string } | { kind: "no-token" };

export function parseSetupToken(output: string): SetupTokenOutput {
  const match = TOKEN.exec(output.replace(ANSI, ""));
  return match ? { kind: "token", token: match[0] } : { kind: "no-token" };
}

const PROMPT = /^paste code here if prompted\s*>?\s*/i;
const RETRY = /^press enter to retry/i;

/**
 * Where `setup-token` stands, read from its screen: `waiting` for the browser,
 * or `stuck` on its retry prompt after an error — Claude Code's words above
 * the prompt, any credential masked. A stuck run never ends on its own.
 */
export type SetupTokenScreen =
  { kind: "waiting" } | { kind: "stuck"; error: string };

export function readSetupTokenScreen(screen: string): SetupTokenScreen {
  const said = lines(screen);
  const retry = said.findLastIndex((l) => RETRY.test(l));
  if (retry === -1) return { kind: "waiting" };
  const above = said[retry - 1];
  return {
    kind: "stuck",
    error:
      above === undefined || PROMPT.test(above)
        ? "Claude Code could not finish signing in."
        : above.replace(ANY_CREDENTIAL, "sk-ant-…"),
  };
}

/**
 * Why a sign-in ended unsuccessfully, in Claude Code's own words: its last
 * line (never its paste prompt), any credential in it masked — this text is
 * pushed to every tab.
 */
export function failureMessage(output: string, exitCode: number): string {
  const said = lines(output)
    .map((l) => l.replace(PROMPT, ""))
    .filter((l) => l !== "");
  const last = said.at(-1);
  return last
    ? last.replace(ANY_CREDENTIAL, "sk-ant-…")
    : `Claude Code's sign-in stopped (exit code ${exitCode}) without saying why.`;
}
