import { describe, expect, test } from "bun:test";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { PIPEFAIL_PREFIX, pipefailGuard } from "./pipefail";

function verdict(command: string): Verdict {
  return pipefailGuard.check({ command }, createContext("/tmp")) as Verdict;
}

const rewritten = (command: string) => {
  const v = verdict(command);
  return v.kind === "rewrite" ? v.patch.command : undefined;
};
const untouched = (command: string) => verdict(command).kind === "allow";

describe("pipefail guard", () => {
  describe("a pipeline ending in a draining reader gets pipefail", () => {
    for (const command of [
      "./equin check 2>&1 | tail -20",
      "./equin check |& tail -20",
      "bun x tsc | tee /tmp/out.log",
      "cd sub && make | tail -n 5",
      "cmd | timeout 5 tail -3",
      "cmd | tail -20\n",
      "for f in a b; do cmd $f | tail -1; done",
      "cmd | rg error | tail -5",
      "cmd | grep -v noise | tail -5",
    ]) {
      test(command, () => {
        expect(rewritten(command)).toBe(PIPEFAIL_PREFIX + command);
      });
    }
  });

  describe("no drained pipe → left alone", () => {
    for (const command of [
      "./equin check",
      "tail -20 build.log",
      "ls | wc -l",
      "echo 'a | tail'",
      "cmd || tail -5 log",
      "x=$(cmd); echo $x",
    ]) {
      test(command, () => {
        expect(untouched(command)).toBe(true);
      });
    }
  });

  describe("any early-exiting reader keeps pipefail off (SIGPIPE → false 141)", () => {
    for (const command of [
      "cmd | head -5 | tail -1",
      "cmd | tail -20; git log | head -3",
      "cmd | tee log | grep -q ok",
      "cmd | tee log | grep -m1 ok",
      "cmd | tee log | rg -l ok",
      "cmd | tee log | grep --quiet ok",
      "cmd | tee log | sed -n '1,10p;10q'",
      "cmd | tee log | sed 5q",
      "cmd | tee log | awk 'NR==3{exit}'",
    ]) {
      test(command, () => {
        expect(untouched(command)).toBe(true);
      });
    }

    test("head reading a FILE is not in a pipe, so it does not count", () => {
      expect(rewritten("head -1 a.txt; cmd | tail -5")).toBeDefined();
    });
  });

  describe("the agent already chose", () => {
    for (const command of [
      "set -o pipefail; cmd | tail -5",
      "set -euo pipefail\ncmd | tail -5",
      "set +o pipefail; cmd | tail -5",
      "setopt pipefail; cmd | tail -5",
      "setopt no_pipe_fail; cmd | tail -5",
    ]) {
      test(command, () => {
        expect(untouched(command)).toBe(true);
      });
    }
  });

  test("the rewrite is idempotent", () => {
    const once = rewritten("cmd | tail -5")!;
    expect(untouched(once as string)).toBe(true);
  });
});
