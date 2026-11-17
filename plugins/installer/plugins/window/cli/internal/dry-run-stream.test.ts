import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  InstallStepId,
  InstallTiming,
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
 * The dry run's HOME: its run dir (`~/.equin/logs/install/<run>/`, from the
 * data root under HOME) lands here, never in the real data root.
 */
const homes: string[] = [];
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "install-dry-run-"));
  homes.push(home);
  return home;
}
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** The run dir the dry run under `home` wrote (`latest` names it). */
function runDir(home: string): string {
  const root = join(home, ".equin", "logs", "install");
  return join(root, readlinkSync(join(root, "latest")));
}

/**
 * Start the dry run as the window does: events on fd 3, decisions on fd 4.
 * `onEvents` sees the stream so far after each chunk.
 */
function startDryRun(
  env: Partial<Record<EnvKey, string>>,
  onEvents: (text: string, child: ChildProcess) => void = () => {},
  home: string = tempHome(),
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
        HOME: home,
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
): Promise<{
  events: InstallEvent[];
  text: string;
  code: number | null;
  home: string;
}> {
  const home = tempHome();
  const { child, result } = startDryRun(env, undefined, home);
  const control = child.stdio[4] as Writable;
  control.end(decisions.map((d) => `${d}\n`).join(""));
  const { text, code } = await result;
  return { events: parseAll(text), text, code, home };
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
    expect(plan.mode).toBe("window");
    // Every step id exactly once, top-level steps and sub-steps together.
    const planned: string[] = plan.steps.flatMap((s) => [
      s.id,
      ...(s.substeps ?? []).map((sub) => sub.id),
    ]);
    expect(planned).toEqual([...InstallStepId.options]);
    // Every step's group is one the plan declares.
    const groups = new Set(plan.groups.map((g) => g.id));
    for (const s of plan.steps) expect(groups.has(s.group)).toBe(true);
    expect(stepStates(events, "tools")).toEqual(["skipped"]);
    for (const id of InstallStepId.options.slice(1))
      expect(stepStates(events, id)).toEqual(["start", "done"]);
  });

  test("progress and waits arrive, the build's through the FIFO by path", async () => {
    const { events } = await dryRun([]);
    const progress = (id: string): number[] =>
      events.flatMap((e) =>
        e.type === "progress" && e.id === id ? [e.done] : [],
      );
    // git's CR-redrawn percentages, once per change.
    expect(progress("clone")).toEqual([0, 12, 37, 64, 88, 100]);
    expect(progress("start").at(-1)).toBe(312);
    expect(progress("build.interface").at(-1)).toBe(1184);
    const waits = events.flatMap((e) => (e.type === "wait" ? [e] : []));
    expect(waits.map((w) => [w.step, w.state, w.on])).toEqual([
      ["build.interface", "start", "host-grant"],
      ["build.interface", "end", "host-grant"],
    ]);
    expect(waits[0]?.holder?.kind).toBe("check");
    // Only the last frame of each phase is kept as a log line.
    const cloneLog = events.flatMap((e) =>
      e.type === "log" && e.step === "clone" ? [e.line] : [],
    );
    expect(cloneLog.filter((l) => l.startsWith("Receiving objects"))).toEqual([
      "Receiving objects: 100% (4100/4100), 10.0 MiB | 2.0 MiB/s, done.",
    ]);
  });

  test("events.jsonl holds what the window saw; timing.json is an InstallTiming", async () => {
    const { text, home } = await dryRun([]);
    const dir = runDir(home);
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toBe(text);
    const timing = InstallTiming.parse(
      JSON.parse(readFileSync(join(dir, "timing.json"), "utf8")),
    );
    expect(timing.dryRun).toBe(true);
    // In the order they finished: the build after its sub-steps.
    const ran: string[] = InstallStepId.options.filter(
      (id) => id !== "tools" && id !== "build",
    );
    expect(Object.keys(timing.steps)).toEqual([...ran, "build"]);
    // The FIFO is gone once the install ended.
    expect(readdirSync(dir).sort()).toEqual(["events.jsonl", "timing.json"]);
  });

  test("every event but the plan is one write under PIPE_BUF; a long log line is cut", async () => {
    const { events, text } = await dryRun([]);
    const lines = text.split("\n").filter((l) => l !== "");
    for (const line of lines.slice(1))
      expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(512);
    const long = events.flatMap((e) =>
      e.type === "log" && e.line.startsWith("long: ") ? [e.line] : [],
    );
    expect(long).toHaveLength(1);
    expect(long[0]!.length).toBeGreaterThan(20);
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

/** The dry run with no window: stdout a pipe, so the terminal view is plain. */
async function plainDryRun(
  env: Partial<Record<EnvKey, string>> = {},
): Promise<{ out: string; err: string; code: number | null; home: string }> {
  const home = tempHome();
  const child = spawn(BASH, [SCRIPT, "--dry-run"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      ...envEntries({ INSTALL_DRY_RUN_PACE: "0", ...env }),
    },
  });
  let out = "";
  let err = "";
  (child.stdout as Readable)
    .setEncoding("utf8")
    .on("data", (c: string) => (out += c));
  (child.stderr as Readable)
    .setEncoding("utf8")
    .on("data", (c: string) => (err += c));
  const code = await new Promise<number | null>((resolve) =>
    child.on("close", (c) => resolve(c)),
  );
  return { out, err, code, home };
}

describe("install.sh --dry-run, plain terminal view", () => {
  test("timestamped [n/N] lines, then equin is ready", async () => {
    const { out, code, home } = await plainDryRun();
    expect(code).toBe(0);
    const lines = out.split("\n").filter((l) => l !== "");
    const stamped = lines.filter((l) => /^\d\d:\d\d:\d\d /.test(l));
    expect(stamped.length).toBeGreaterThan(10);
    expect(stamped).toContainEqual(
      expect.stringMatching(
        /^\d\d:\d\d:\d\d \[1\/5\] prepare your mac: already installed$/,
      ),
    );
    expect(stamped).toContainEqual(
      expect.stringMatching(
        /\[5\/5\] build › build the interface: 25% \(296\/1184 plugins\)$/,
      ),
    );
    expect(stamped).toContainEqual(
      expect.stringMatching(
        /\[5\/5\] build › build the interface: Waiting for another task to finish · a check started \d+ min ago$/,
      ),
    );
    // No estimate is measured yet: no "usually", no time left.
    expect(out).not.toContain("usually");
    expect(out).not.toContain("left");
    expect(stamped.at(-1)).toMatch(
      /^\d\d:\d\d:\d\d equin is ready · installed in \d+s · http:\/\/equin\.localhost:9000$/,
    );
    // The same events were recorded.
    const recorded = parseAll(
      readFileSync(join(runDir(home), "events.jsonl"), "utf8"),
    );
    expect(recorded[0]).toMatchObject({ type: "plan", mode: "plain" });
    expect(recorded.at(-1)).toMatchObject({ type: "exit", code: 0 });
  });

  test("a failed step: its last lines, then the message, after the view", async () => {
    const { out, err, code } = await plainDryRun({
      INSTALL_DRY_RUN_FAIL: "toolchain",
    });
    expect(code).toBe(1);
    expect(out).toMatch(
      /\[3\/5\] install bun, go and rust: failed after \d+s\n {2}> /,
    );
    expect(out).toContain("  > toolchain: failed (dry run, first attempt)");
    expect(out).not.toContain("  > clone:");
    expect(out).not.toContain("equin is ready");
    expect(err).toContain("The toolchain step of the dry run failed.");
  });
});
