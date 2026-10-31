import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "claude-sdk/no-claude-bin-spawn",
    paths: ["machine/internal/run.ts"],
    kind: "sanctioned",
    reason:
      "Signing in has no Agent SDK form: the bundled Claude Code's own `auth login` / `setup-token` are the only way to sign the computer (or a new account) in, so the app runs them itself instead of telling the user to.",
  },
  {
    rule: "spawn-safety/no-raw-bun-spawn",
    paths: ["machine/internal/run.ts"],
    kind: "sanctioned",
    reason:
      "A streaming child: the sign-in is read live and written to live, so after-exit capture cannot run it. `auth login`'s output is a file descriptor onto a watched file (never a pipe) and the code pasted from another device goes to its stdin, a write-only sink with no stream pull; `setup-token` is a terminal UI, run under Bun's pseudo-terminal, whose output Bun pushes to a callback and whose input is the terminal's write.",
  },
] satisfies Exemptions;
