import { expect, test } from "bun:test";
import {
  parseDaemonSockets,
  parseRunningDaemons,
  tokenDaemonPid,
} from "./daemons";

test("only the daemon itself is a daemon, not its start / stop / status clients; priority 4 is throttled", () => {
  const ps = [
    "  101 20 /Library/Developer/CommandLineTools/usr/libexec/git-core/git fsmonitor--daemon run --detach --ipc-threads=8",
    "  102 20 git fsmonitor--daemon start",
    "  103 31 git -C /x fsmonitor--daemon status",
    "  104  4 git fsmonitor--daemon run",
    "  105 20 vim notes-about-git fsmonitor--daemon run.txt",
    "",
  ].join("\n");
  expect([...parseRunningDaemons(ps)]).toEqual([
    [101, { throttled: false }],
    [104, { throttled: true }],
  ]);
});

test("each pid's socket names its git dir; other unix sockets are ignored", () => {
  const lsof = [
    "p101",
    "n->0xc8481013d3a64bde",
    "n/repo/.git/worktrees/att-1/fsmonitor--daemon.ipc",
    "p104",
    "n/repo/.git/fsmonitor--daemon.ipc",
    "p105",
    "n->0xa0a8070bfec91877",
  ].join("\n");
  expect([...parseDaemonSockets(lsof)]).toEqual([
    [101, "/repo/.git/worktrees/att-1"],
    [104, "/repo/.git"],
  ]);
});

test("a builtin token names the daemon's pid; anything else names none", () => {
  expect(tokenDaemonPid("builtin:0.50938.20261118T105943.262417Z:0")).toBe(
    50938,
  );
  expect(tokenDaemonPid("builtin:3.7.20261118T105943.262417Z:12")).toBe(7);
  expect(tokenDaemonPid("v1:1731923983000000000")).toBeNull();
  expect(tokenDaemonPid(null)).toBeNull();
});
