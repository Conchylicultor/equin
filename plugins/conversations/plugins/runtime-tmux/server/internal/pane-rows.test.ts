import { describe, expect, test } from "bun:test";
import { PANE_ROW_FORMAT, parsePaneRows } from "./pane-rows";

function row(
  session: string,
  pid = "100",
  paneId = "%1",
  title = "✳ Fix it",
  path = "/elsewhere",
  hostedBy = "",
): string {
  return [session, pid, paneId, "0", path, hostedBy, title].join("\t");
}

const WT = "/repo/.claude/worktrees/att-1";
const isAgentWorktree = (p: string) => p === WT;

describe("parsePaneRows", () => {
  test("keeps launched sessions, and others only when started from an agent worktree", () => {
    const panes = parsePaneRows(
      [
        row("conv-1791321671-ov6h", "1", "%1"),
        row("claude-1787000000-abcd", "2", "%2"),
        // An agent's own `tmux new-session` from its checkout: listed, so main
        // adopts it as a lost conversation.
        row("spike-auq", "3", "%3", "✳", WT),
        // A hand-made session anywhere else is the user's, not ours.
        row("spike-other", "4", "%4"),
        row("main", "5", "%5"),
      ].join("\n"),
      isAgentWorktree,
    );
    expect([...panes.keys()]).toEqual([
      "conv-1791321671-ov6h",
      "claude-1787000000-abcd",
      "spike-auq",
    ]);
  });

  test("parses one pane, the title keeping its tabs", () => {
    const panes = parsePaneRows(
      `${row("conv-1-a", "42", "%7", "✳ a\tb")}\n`,
      isAgentWorktree,
    );
    expect(panes.get("conv-1-a")).toEqual({
      panePid: 42,
      paneId: "%7",
      dead: false,
      worktreePath: "/elsewhere",
      rawTitle: "✳ a\tb",
    });
  });

  test("first pane of a session wins; malformed lines are skipped", () => {
    const panes = parsePaneRows(
      [
        row("conv-1-a", "1", "%1"),
        row("conv-1-a", "2", "%2"),
        row("conv-1-b", "not-a-pid", "%3"),
        "conv-1-c",
      ].join("\n"),
      isAgentWorktree,
    );
    expect([...panes.keys()]).toEqual(["conv-1-a"]);
    expect(panes.get("conv-1-a")?.paneId).toBe("%1");
  });

  test("skips a session another runtime hosts, whatever its name or path", () => {
    const panes = parsePaneRows(
      [
        row("conv-1-a", "1", "%1"),
        row("conv-1-b", "2", "%2", "✳", "/elsewhere", "sdk"),
        row("spike-auq", "3", "%3", "✳", WT, "sdk"),
      ].join("\n"),
      isAgentWorktree,
    );
    expect([...panes.keys()]).toEqual(["conv-1-a"]);
  });

  test("the format reads the host option, before the title", () => {
    expect(PANE_ROW_FORMAT.split("\t").slice(-2)).toEqual([
      "#{@singularity-host}",
      "#{pane_title}",
    ]);
  });

  test("empty output is no panes", () => {
    expect(parsePaneRows("", isAgentWorktree).size).toBe(0);
  });
});
