import { describe, expect, test } from "bun:test";
import type { Finding, IoHealth } from "../../core";
import { ioHealthVerdict, MONITOR_STALE_MS } from "./io-health-verdict";

const AT = 1_793_700_000_000;
const refetch = async () => {};
const present = (findings: Finding[]): IoHealth => ({
  monitor: "present",
  latest: { at: AT, maxOpMs: 20, readOpsS: 4000, msPerOp: 0.61, load1: 3 },
  root: false,
  findings,
});
const finding = (
  rule: Finding["rule"],
  severity: Finding["severity"],
): Finding => ({
  rule,
  subject: "x",
  severity,
  summary: `${rule} happened`,
  since: AT,
  evidence: [],
});

describe("Disk I/O row verdict", () => {
  test("never green before the read lands", () => {
    expect(ioHealthVerdict({ status: "loading", refetch }, AT).status).toEqual({
      state: "unknown",
    });
  });

  test("a monitor not installed is attention, not all good", () => {
    const v = ioHealthVerdict(
      { status: "ready", refetch, data: { monitor: "missing" } },
      AT,
    );
    expect(v.status.state).toBe("attention");
  });

  test("healthy until the newest tick goes stale, then attention", () => {
    const fresh = ioHealthVerdict(
      { status: "ready", refetch, data: present([]) },
      AT + 1000,
    );
    expect(fresh.status.state).toBe("ok");
    expect(fresh.nextChangeAt).toBe(AT + MONITOR_STALE_MS);
    const stale = ioHealthVerdict(
      { status: "ready", refetch, data: present([]) },
      AT + MONITOR_STALE_MS,
    );
    expect(stale.status.state).toBe("attention");
    expect("summary" in stale.status && stale.status.summary).toContain(
      "has written nothing since",
    );
  });

  test("a stall is critical; the first finding is the summary", () => {
    const v = ioHealthVerdict(
      {
        status: "ready",
        refetch,
        data: present([
          finding("daemon-cpu", "attention"),
          finding("metadata-stall", "critical"),
        ]),
      },
      AT,
    );
    expect(v.status).toEqual({
      state: "critical",
      summary: "daemon-cpu happened (+1 more)",
    });
  });

  test("no computer behind this host: not applicable", () => {
    const v = ioHealthVerdict(
      { status: "unavailable", message: "Needs the desktop app" },
      AT,
    );
    expect(v.status).toEqual({
      state: "not-applicable",
      summary: "Needs the desktop app",
    });
  });
});
