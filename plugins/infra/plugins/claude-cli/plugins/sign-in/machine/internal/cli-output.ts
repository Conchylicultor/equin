import type { ClaudeSignInMethod, ClaudeSignInTarget } from "../../core";

// What Claude Code's sign-in commands are asked, and what their output means —
// pure, so the reading is pinned by tests and adjusted in one place when a new
// Claude Code build changes its wording.
//
// Observed with the bundled 2.1.310 (piped stdio, no TTY):
// - `auth login [--console|--sso]` prints, within ~300 ms,
//   "Opening browser to sign in…\nIf the browser didn't open, visit: <URL>\n
//   Paste code here if prompted > " — <URL> is the manual flow (its page shows
//   a code, read back on stdin). It also hands $BROWSER a second URL whose
//   localhost callback completes the sign-in by itself.
// - `setup-token` prints nothing while it waits; it hands $BROWSER its URL.
//   How it prints the token on success has not been observed yet: the token is
//   read as the first `sk-ant-oat…` in its output, and none is a failure.

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

/** The page for another device `auth login` printed, or null before it has. */
export function parseManualUrl(output: string): string | null {
  for (const line of lines(output)) {
    const match = /visit:\s*(https:\/\/\S+)/.exec(line);
    if (match?.[1]) return match[1];
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
