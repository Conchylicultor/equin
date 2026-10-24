import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { macosAutomationGuard } from "./macos-automation";

function verdict(command: string, cwd = "/tmp"): Verdict {
  // Synchronous check (hasBypass stats a path); /tmp holds no
  // `.allow-macos-automation`, so the bypass is off.
  return macosAutomationGuard.check({ command }, createContext(cwd)) as Verdict;
}

const blocks = (command: string) => verdict(command).kind === "deny";

describe("macos-automation guard", () => {
  describe("blocked", () => {
    test.each([
      [
        "osascript -e",
        `osascript -e 'tell application "System Events" to get name of every process'`,
      ],
      ["osascript with a script file", "osascript ./check.scpt"],
      ["osascript by absolute path", "/opt/local/bin/osascript -e 1"],
      ["screencapture", "screencapture -x /tmp/shot.png"],
      ["automator", "automator -i in.txt flow.workflow"],
      ["cliclick", "cliclick c:100,200"],
      ["peekaboo", "peekaboo image --app Safari"],
      ["shortcuts run", "shortcuts run 'Take Screenshot'"],
      ["later in a chain", "pgrep -x Finder && osascript -e 1"],
      ["in a pipeline", "echo 1 | osascript"],
      ["inside $( … )", `echo "$(osascript -e 'return 1')"`],
      ["inside backticks", "echo `screencapture -x a.png`"],
      ["in a subshell", "(cd /tmp && osascript -e 1)"],
      ["behind env", "env FOO=1 osascript -e 1"],
      ["behind sudo", "sudo screencapture a.png"],
      ["behind nohup", "nohup osascript -e 1 &"],
      ["behind xargs", "echo a.scpt | xargs osascript"],
      ["behind exec", "exec osascript -e 1"],
      ["bash -c", `bash -c "osascript -e 1"`],
      ["sh -c", "sh -c 'screencapture a.png'"],
      ["zsh -lc", `zsh -lc "osascript -e 1"`],
      ["nested bash -c", `bash -c "bash -c 'osascript -e 1'"`],
      ["eval", `eval "osascript -e 1"`],
      ["bash heredoc", "bash <<'EOF'\nosascript -e 1\nEOF"],
    ])("%s", (_label, command) => {
      expect(blocks(command)).toBe(true);
    });
  });

  describe("allowed", () => {
    test.each([
      ["the name as an echo argument", "echo osascript"],
      ["searching for it", "rg osascript plugins/"],
      ["a commit message mentioning it", `git commit -m "osascript"`],
      ["shortcuts list", "shortcuts list"],
      ["shortcuts view", "shortcuts view Foo"],
      [
        "a heredoc body that mentions it",
        "cat > notes.md <<'EOF'\nosascript -e 1\nEOF",
      ],
      ["open", "open http://x.localhost:9000"],
      ["lsappinfo", "lsappinfo list"],
      ["pgrep", "pgrep -x Finder"],
      ["ps", "ps aux"],
      ["pbcopy", "echo hi | pbcopy"],
      ["say", "say done"],
      ["defaults", "defaults read com.apple.finder"],
      ["mdfind", "mdfind -name foo"],
      ["tccutil", "tccutil reset AppleEvents"],
      ["bash -c without it", `bash -c "echo osascript"`],
    ])("%s", (_label, command) => {
      expect(blocks(command)).toBe(false);
    });
  });

  test("the bypass file lets it through", () => {
    const dir = mkdtempSync(join(tmpdir(), "macos-automation-"));
    try {
      expect(verdict("osascript -e 1", dir).kind).toBe("deny");
      writeFileSync(join(dir, ".allow-macos-automation"), "");
      expect(verdict("osascript -e 1", dir).kind).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
