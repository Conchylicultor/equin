import { describe, expect, test } from "bun:test";
import {
  checkoutKindOf,
  gitWaitDetail,
  indexTraceEnv,
  splitIndexTrace,
} from "./git-read-facts";

// trace2 event lines as git 2.50.1 writes them (GIT_TRACE2_EVENT_BRIEF=1),
// captured from real reads: a status the fsmonitor answered, one with
// fsmonitor off (a full scan), and one answered trivially (a restarted daemon).
const data = (nesting: number, category: string, key: string, value: string) =>
  JSON.stringify({
    event: "data",
    sid: "s",
    thread: "main",
    t_abs: 0.01,
    t_rel: 0.0,
    nesting,
    category,
    key,
    value,
  });
const version =
  '{"event":"version","sid":"s","thread":"main","evt":"4","exe":"2.50.1"}';

const readIndex = (msg: string) =>
  JSON.stringify({
    event: "region_enter",
    sid: "s",
    thread: "main",
    repo: 1,
    nesting: 1,
    category: "index",
    label: "do_read_index",
    msg,
  });

describe("splitIndexTrace", () => {
  test("an answered query: few lstat calls", () => {
    const stderr = [
      version,
      readIndex(".git/index"),
      data(2, "fsm_client", "query/command", "builtin:0.1.x:0"),
      data(2, "fsm_client", "query/response-length", "184"),
      data(2, "index", "preload/sum_lstat", "1"),
      data(2, "index", "refresh/sum_lstat", "1"),
      "",
    ].join("\n");
    expect(splitIndexTrace(stderr)).toEqual({
      stderr: "",
      facts: { fsmonitor: "answered", lstats: 2, indexPath: ".git/index" },
    });
  });

  test("fsmonitor off: every file stat'ed", () => {
    const stderr = [
      version,
      readIndex("/u/repo/.git/worktrees/a/index"),
      data(2, "index", "preload/sum_lstat", "26664"),
      data(2, "index", "refresh/sum_lstat", "1"),
    ].join("\n");
    expect(splitIndexTrace(stderr).facts).toEqual({
      fsmonitor: "off",
      lstats: 26665,
      indexPath: "/u/repo/.git/worktrees/a/index",
    });
  });

  test("a trivial response (a token the daemon did not issue)", () => {
    const stderr = [
      readIndex("/u/repo/.git/worktrees/a/index"),
      data(2, "fsm_client", "query/command", "builtin:0.2.y:0"),
      data(1, "fsm_client", "query/trivial-response", "1"),
      data(2, "index", "refresh/sum_lstat", "26664"),
    ].join("\n");
    expect(splitIndexTrace(stderr).facts?.fsmonitor).toBe("trivial");
  });

  test("a command that read no index has no facts", () => {
    expect(splitIndexTrace([version, ""].join("\n")).facts).toBeNull();
  });

  test("git's own messages are kept, in order — a cut trace line too", () => {
    const stderr = [
      "warning: one",
      version,
      '{"event":"data","sid":"s","ke',
      "fatal: two",
    ].join("\n");
    expect(splitIndexTrace(stderr).stderr).toBe(
      'warning: one\n{"event":"data","sid":"s","ke\nfatal: two',
    );
  });
});

describe("indexTraceEnv", () => {
  test("only index reads are traced", () => {
    expect(indexTraceEnv("status")).not.toBeNull();
    expect(indexTraceEnv("diff")).not.toBeNull();
    expect(indexTraceEnv("ls-files")).not.toBeNull();
    expect(indexTraceEnv("rev-parse")).toBeNull();
    expect(indexTraceEnv("merge-base")).toBeNull();
  });
});

describe("checkoutKindOf", () => {
  const root = "/u/repo";
  test("from the path's layout", () => {
    expect(checkoutKindOf("/h/.equin/services/main-slots/slot-3", null)).toBe(
      "main slot",
    );
    expect(checkoutKindOf(`${root}/.claude/worktrees/att-1-x`, null)).toBe(
      "agent checkout",
    );
    expect(checkoutKindOf(`${root}/.claude/worktrees/spare-1-y/`, null)).toBe(
      "spare",
    );
    expect(checkoutKindOf(root, null)).toBe("other checkout");
  });
  test("a main root by the index git read", () => {
    expect(checkoutKindOf(root, ".git/index")).toBe("main root");
    expect(checkoutKindOf(root, `${root}/.git/index`)).toBe("main root");
    expect(
      checkoutKindOf("/u/other", "/u/repo/.git/worktrees/other/index"),
    ).toBe("other checkout");
  });
});

describe("gitWaitDetail", () => {
  test("the variant is the kind, plus the fsmonitor answer for an index read", () => {
    expect(gitWaitDetail("/s/main-slots/slot-0", null)).toEqual({
      variant: "main slot",
      subject: "/s/main-slots/slot-0",
    });
    const wt = "/u/repo/.claude/worktrees/att-1-x";
    expect(
      gitWaitDetail(wt, {
        fsmonitor: "trivial",
        lstats: 9,
        indexPath: "/u/repo/.git/worktrees/spare-1/index",
      }),
    ).toEqual({
      variant: "agent checkout · fsmonitor trivial",
      measures: { lstats: 9 },
      subject: wt,
    });
  });
});
