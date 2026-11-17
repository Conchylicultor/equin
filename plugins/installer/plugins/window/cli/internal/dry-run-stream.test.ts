import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  InstallStepId,
  parseInstallEventLine,
  type InstallEvent,
} from "@plugins/installer/core";
import {
  envEntries,
  type EnvKey,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";

/**
 * install.sh writes its events by hand (bash, no JSON library); this holds
 * that emitter to the one schema (installer/core) by running `--dry-run` —
 * every event type, a skipped step, output that needs escaping — under the
 * bash every Mac ships (3.2), the one the curl install runs on.
 */

const BASH = "/bin/bash";
const SCRIPT = join(REPO_ROOT, "install.sh");

/**
 * Start the dry run as the window does: events on fd 3, decisions on fd 4.
 * `onEvents` sees the stream so far after each chunk.
 */
function startDryRun(
  env: Partial<Record<EnvKey, string>>,
  onEvents: (text: string, child: ChildProcess) => void = () => {},
): {
  child: ChildProcess;
  result: Promise<{ text: string; code: number | null }>;
} {
  const child = spawn(
    BASH,
    [SCRIPT, "--dry-run", "--events-fd", "3", "--control-fd", "4"],
    {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...envEntries({ INSTALL_DRY_RUN_PACE: "0", ...env }),
      },
    },
  );
  const events = child.stdio[3] as Readable;
  let text = "";
  events.setEncoding("utf8");
  events.on("data", (chunk: string) => {
    text += chunk;
    onEvents(text, child);
  });
  const result = new Promise<{ text: string; code: number | null }>(
    (resolve) => {
      child.on("close", (code) => resolve({ text, code }));
    },
  );
  return { child, result };
}

function parseAll(text: string): InstallEvent[] {
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((line) => {
      const parsed = parseInstallEventLine(line);
      if (!parsed.ok) throw new Error(`${parsed.error}\n${line}`);
      return parsed.event;
    });
}

/** Run the dry run with `decisions` written on fd 4, then fd 4 closed. */
async function dryRun(
  decisions: string[],
  env: Partial<Record<EnvKey, string>> = {},
): Promise<{ events: InstallEvent[]; code: number | null }> {
  const { child, result } = startDryRun(env);
  const control = child.stdio[4] as Writable;
  control.end(decisions.map((d) => `${d}\n`).join(""));
  const { text, code } = await result;
  return { events: parseAll(text), code };
}

function stepStates(events: InstallEvent[], id: string): string[] {
  return events.flatMap((e) =>
    e.type === "step" && e.id === id ? [e.state] : [],
  );
}

describe("install.sh --dry-run event stream", () => {
  test("every line is an event of the schema, plan first and exit last", async () => {
    const { events, code } = await dryRun([]);
    expect(code).toBe(0);
    expect(events[0]?.type).toBe("plan");
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 0 });
    expect(events.at(-2)?.type).toBe("done");
    const plan = events[0];
    if (plan?.type !== "plan") throw new Error("no plan");
    expect(plan.steps.map((s) => s.id)).toEqual(InstallStepId.options);
    expect(stepStates(events, "tools")).toEqual(["skipped"]);
    for (const id of InstallStepId.options.slice(1))
      expect(stepStates(events, id)).toEqual(["start", "done"]);
  });

  test("log lines survive escaping byte for byte", async () => {
    const { events } = await dryRun([]);
    const lines = events.flatMap((e) =>
      e.type === "log" && e.step === "toolchain" ? [e.line] : [],
    );
    expect(lines).toContain('quotes "x", a backslash \\ and a tab:\tdone');
    expect(lines).toContain("\u001b[32mcolour\u001b[0m codes");
    expect(lines).toContain("unicode: é ✓ 漢字");
    expect(lines).toContain("no trailing newline");
    expect(lines).toContain("this line went to stderr");
  });

  test("a failed step waits for the decision on fd 4: retry runs it again", async () => {
    const { events, code } = await dryRun(["retry"], {
      INSTALL_DRY_RUN_FAIL: "clone",
    });
    expect(code).toBe(0);
    expect(stepStates(events, "clone")).toEqual([
      "start",
      "failed",
      "start",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 0 });
  });

  test("quit stops the install: no done, exit 1", async () => {
    const { events, code } = await dryRun(["quit"], {
      INSTALL_DRY_RUN_FAIL: "toolchain",
    });
    expect(code).toBe(1);
    expect(stepStates(events, "toolchain")).toEqual(["start", "failed"]);
    expect(stepStates(events, "start")).toEqual([]);
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 1 });
  });

  test("an unknown decision is ignored; the window closing (EOF) is quit", async () => {
    const { events, code } = await dryRun(["maybe"], {
      INSTALL_DRY_RUN_FAIL: "mise",
    });
    expect(code).toBe(1);
    expect(stepStates(events, "mise")).toEqual(["start", "failed"]);
  });

  test("stopped by a signal while paused: the exit event says so", async () => {
    // fd 4 stays open (no decision comes), as in a window that is closed.
    const { child, result } = startDryRun(
      { INSTALL_DRY_RUN_FAIL: "clone" },
      (text, c) => {
        if (text.includes('"state":"failed"') && c.signalCode === null)
          c.kill("SIGINT");
      },
    );
    const { text, code } = await result;
    (child.stdio[4] as Writable).end();
    expect(code).toBe(130);
    expect(parseAll(text).at(-1)).toMatchObject({ type: "exit", code: 130 });
  });
});
