import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { BACKGROUND_SHELL, DEMOTE_FLAGS, TASKPOLICY } from "./background";

// The script cannot import the flags, so its demotion is pinned to them here.
test("background-shell demotes with the same taskpolicy flags", () => {
  expect(readFileSync(BACKGROUND_SHELL, "utf8")).toContain(
    `exec ${[TASKPOLICY, ...DEMOTE_FLAGS, "--"].join(" ")} `,
  );
});

// Claude Code hands it the whole command as one argument, which the CLI's
// shell (CLAUDE_CODE_SHELL, else SHELL) parses: quoting, operators and
// expansions survive, and the environment passes through.
test.skipIf(process.platform !== "darwin")(
  "background-shell runs one command string in the CLI's shell",
  () => {
    const run = Bun.spawnSync(
      [BACKGROUND_SHELL, `printf '%s|' "$0" "a b" && echo "$PROBE"`],
      { env: { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh", PROBE: "kept" } },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("/bin/zsh|a b|kept\n");
  },
);
