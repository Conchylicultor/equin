import { describe, expect, it } from "bun:test";
import {
  attributeProcesses,
  parsePs,
  sumByBucket,
  type PsProcess,
} from "./attribute";

function proc(pid: number, ppid: number, args: string, cpu = 1): PsProcess {
  return { pid, ppid, cpu, rssBytes: pid * 1024, args };
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_HELPER =
  "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer";
const PLAYWRIGHT = "Chromium.app/Contents/MacOS/Chromium --headless";

describe("parsePs", () => {
  it("reads pid, ppid, cpu, rss (KB) and the full command", () => {
    expect(
      parsePs("  12     1  3.5  2048 /bin/zsh -l\n\n 13 12 0.0 4 sleep 9\n"),
    ).toEqual([
      {
        pid: 12,
        ppid: 1,
        cpu: 3.5,
        rssBytes: 2048 * 1024,
        args: "/bin/zsh -l",
      },
      { pid: 13, ppid: 12, cpu: 0, rssBytes: 4096, args: "sleep 9" },
    ]);
  });

  it("throws on a line it cannot read", () => {
    expect(() => parsePs("not a ps line")).toThrow(/unexpected ps line/);
  });
});

describe("attributeProcesses", () => {
  const procs = [
    proc(1, 0, "/sbin/launchd"),
    proc(100, 1, CHROME),
    proc(101, 100, CHROME_HELPER),
    proc(200, 1, "bun bin/host.ts"),
    proc(201, 200, PLAYWRIGHT),
    proc(202, 201, `${PLAYWRIGHT} --type=gpu-process`),
    proc(300, 1, "bun cli/singularity build"),
    proc(301, 300, "bun vite build"),
    proc(302, 301, CHROME), // an e2e run's own Chrome
    proc(400, 1, "claude --print"),
  ];

  it("claims each root's whole subtree, then Chrome's bundle, else other", () => {
    const owner = attributeProcesses(procs, {
      agentBrowser: 200,
      agentOps: [300],
    });
    expect(Object.fromEntries(owner)).toEqual({
      1: "other",
      100: "chrome",
      101: "chrome",
      200: "agent-browser",
      201: "agent-browser",
      202: "agent-browser",
      300: "agent-ops",
      301: "agent-ops",
      302: "agent-ops",
      400: "other",
    });
  });

  it("ignores a root ps no longer lists", () => {
    const owner = attributeProcesses(procs, {
      agentBrowser: 999,
      agentOps: [998],
    });
    expect(owner.get(200)).toBe("other");
    expect(owner.get(302)).toBe("chrome");
  });
});

describe("sumByBucket", () => {
  it("totals every bucket, in display order, empty ones included", () => {
    const procs = [
      proc(1, 0, "launchd", 2),
      proc(100, 1, CHROME, 30),
      proc(101, 100, CHROME_HELPER, 10),
    ];
    const owner = attributeProcesses(procs, {
      agentBrowser: null,
      agentOps: [],
    });
    expect(sumByBucket(procs, owner, (p) => p.pid)).toEqual([
      { bucket: "chrome", processes: 2, cpuPercent: 40, memBytes: 201 },
      { bucket: "agent-ops", processes: 0, cpuPercent: 0, memBytes: 0 },
      { bucket: "agent-browser", processes: 0, cpuPercent: 0, memBytes: 0 },
      { bucket: "other", processes: 1, cpuPercent: 2, memBytes: 1 },
    ]);
  });
});
