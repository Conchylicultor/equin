import { describe, expect, test } from "bun:test";
import {
  parseAgentProcesses,
  parseEtime,
  pidFileVerdict,
} from "./orphan-agents";

const ROOT = "/data/locks/sdk-agents";

describe("parseEtime", () => {
  test("mm:ss, hh:mm:ss and dd-hh:mm:ss", () => {
    expect(parseEtime("01:05")).toBe(65_000);
    expect(parseEtime("2:00:00")).toBe(7_200_000);
    expect(parseEtime("10-06:49:01")).toBe(
      ((10 * 24 + 6) * 3600 + 49 * 60 + 1) * 1000,
    );
  });

  test("anything else is not an elapsed time", () => {
    expect(parseEtime("")).toBeNull();
    expect(parseEtime("abc")).toBeNull();
  });
});

describe("parseAgentProcesses", () => {
  // The leaked agent of 2026-11-08, as `ps -axo pid=,etime=,command=` shows it:
  // its executable path holds spaces, so the pid file is found by its flag.
  const agent = `28993 10-06:49:01 /data/state/sdk-agents/ns-main/conv-1/bin/agent-conv-1 agent.ts --dir /data/state/sdk-agents/ns-main/conv-1 --socket /data/sockets/agents/ns-main/conv-1.sock --pid-file ${ROOT}/ns-main/conv-1.pid --account acct-1 --usage-file /data/state/claude-usage/acct-1.json`;

  test("an agent's line: its pid, age and pid file", () => {
    expect(parseAgentProcesses(agent, ROOT)).toEqual([
      {
        pid: 28993,
        ageMs: ((10 * 24 + 6) * 3600 + 49 * 60 + 1) * 1000,
        namespace: "ns-main",
        conversationId: "conv-1",
      },
    ]);
  });

  test("its Claude Code child, and anything else, is not an agent", () => {
    const out = [
      agent,
      "29035 10-06:48:59 /data/state/sdk-agents/ns-main/conv-1/bin/claude-conv-1 --output-format stream-json",
      "  501 01:00 /usr/sbin/some-daemon --pid-file /var/run/other.pid",
      // A pid file under the root but not at <root>/<ns>/<id>.pid.
      `  777 01:00 bun x.ts --pid-file ${ROOT}/a/b/c.pid`,
    ].join("\n");
    expect(parseAgentProcesses(out, ROOT).map((a) => a.pid)).toEqual([28993]);
  });
});

describe("pidFileVerdict", () => {
  test("a pid file naming the process: not an orphan", () => {
    expect(pidFileVerdict(42, { kind: "pid", pid: 42 })).toEqual({
      kind: "named",
    });
  });

  test("no pid file: an orphan", () => {
    expect(pidFileVerdict(42, { kind: "absent" }).kind).toBe("orphan");
  });

  test("a pid file naming another process: an orphan", () => {
    expect(pidFileVerdict(42, { kind: "pid", pid: 2 ** 22 - 1 }).kind).toBe(
      "orphan",
    );
  });

  test("a pid file being written: left for the next sweep", () => {
    expect(pidFileVerdict(42, { kind: "unreadable", text: "" })).toEqual({
      kind: "being-written",
    });
  });
});
