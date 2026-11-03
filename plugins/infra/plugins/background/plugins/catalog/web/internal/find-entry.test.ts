import { describe, expect, test } from "bun:test";
import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { BackgroundEntry } from "../../core";
import { findEntry } from "./find-entry";

const refetch = () => Promise.resolve();

function entry(kind: string, name: string): BackgroundEntry {
  return {
    kind,
    name,
    description: name,
    group: "G",
    trigger: { kind: "boot" },
    scope: "every-worktree",
    runsHere: true,
    declaredIn: null,
    lastRun: null,
    history: null,
    canRunNow: false,
    internal: false,
    facts: [],
  };
}

const ready = (
  ...es: BackgroundEntry[]
): ResourceResult<BackgroundEntry[]> => ({
  status: "ready",
  data: es,
  refetch,
});
const loading: ResourceResult<BackgroundEntry[]> = {
  status: "loading",
  refetch,
};

describe("findEntry", () => {
  test("found in a ready half even while the other still loads", () => {
    const r = findEntry([ready(entry("timer", "a")), loading], "timer", "a");
    expect(r.status === "ready" && r.data?.name).toBe("a");
  });

  test("loading — not absent — while a half that might hold it loads", () => {
    const r = findEntry([ready(), loading], "central-timer", "x");
    expect(r.status).toBe("loading");
  });

  test("absent only once both halves answered", () => {
    const r = findEntry([ready(), ready()], "timer", "x");
    expect(r.status === "ready" && r.data).toBe(null);
  });
});
