import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import * as net from "node:net";
import { dirname } from "node:path";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { declareRuntimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { resetRuntimeNamespaceForTest } from "@plugins/infra/plugins/runtime-identity/core/testing";
import { agentSocketPath } from "./paths";

// An agent that exits after the backend's connection was established, before
// the backend wrote its command. `connect` fires once the kernel queued the
// connection, not once the agent took it, so an agent exiting in between (as
// `shutdown` in bin/agent.ts does: listener closed, socket removed, exit) makes
// the backend's first write meet a closed peer: `write EPIPE`.
//
// The race is microseconds wide in production (6 reports in a week). Here it
// is held open: every connection the client makes runs one `connect` listener
// first that waits, synchronously, until the agent has gone — so the client's
// own write comes after it, deterministically.
//
// It also exits when its stdin closes: the test holds the write end, so a
// test that fails before connecting — or a test process that dies — ends it
// too (2026-11-08: three of these, never connected to, sat orphaned for 45 h).
const EXITING_AGENT = `
const [path] = process.argv.slice(1);
process.stdin.on("end", () => process.exit(0)).resume();
require("node:net")
  .createServer(() => {
    require("node:fs").rmSync(path, { force: true });
    process.exit(0);
  })
  .listen(path, () => console.log("listening"));
`;

/** Long enough for the agent's exit to close its end once its socket is gone. */
const EXIT_SETTLE_MS = 300;

// Taken before the mock: `net` is a live binding to the mocked module.
const realNet = { ...net };
const namespace = asNamespace(`sc-test-${process.pid}`);
// The mock is process-wide: only a connection to this suite's own agent socket
// is held; every other one is the real `connect`, untouched.
const isOwnAgentSocket = (target: unknown): target is string =>
  typeof target === "string" && target.includes(`/agents/${namespace}/`);
/** The socket errors the held connections met: the race really ran. */
const seen: (string | undefined)[] = [];
void mock.module("node:net", () => ({
  ...realNet,
  connect: (...args: Parameters<typeof net.connect>) => {
    const conn = realNet.connect(...args);
    const path = args[0];
    if (!isOwnAgentSocket(path)) return conn;
    conn.on("error", (err: NodeJS.ErrnoException) => void seen.push(err.code));
    conn.prependOnceListener("connect", () => {
      const deadline = Date.now() + 5_000;
      while (existsSync(path)) {
        if (Date.now() > deadline) throw new Error("the agent never exited");
      }
      const settled = Date.now() + EXIT_SETTLE_MS;
      while (Date.now() < settled) {
        // the agent's process exit closes its end of the connection
      }
    });
    return conn;
  },
}));
const { AgentNotRunningError, helloAgent } = await import("./socket-client");

/** Every agent started, so `afterAll` ends the ones a failed test left. */
const agents: Bun.Subprocess<"pipe", "pipe", "inherit">[] = [];

async function startExitingAgent(
  path: string,
): Promise<Bun.Subprocess<"pipe", "pipe", "inherit">> {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const child = Bun.spawn([process.execPath, "-e", EXITING_AGENT, path], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  agents.push(child);
  const { value } = await child.stdout.getReader().read();
  expect(new TextDecoder().decode(value)).toContain("listening");
  return child;
}

describe("an agent that exits between our connect and our write", () => {
  beforeAll(() => {
    resetRuntimeNamespaceForTest();
    declareRuntimeNamespace(namespace);
  });
  afterAll(async () => {
    // Closing its stdin is what ends an agent nothing connected to.
    for (const agent of agents.splice(0)) {
      void agent.stdin.end();
      await agent.exited;
    }
    rmSync(dirname(agentSocketPath("conv-x")), {
      recursive: true,
      force: true,
    });
    resetRuntimeNamespaceForTest();
    void mock.module("node:net", () => realNet);
  });

  test("is not running: its socket is gone, so the EPIPE is the agent's exit", async () => {
    const id = `conv-exit-${process.pid}`;
    const agent = await startExitingAgent(agentSocketPath(id));
    // Was the raw `write EPIPE`, thrown as itself: it failed the sdk runtime's
    // whole list pass, and the teardown jobs that ask a closing agent to stop.
    expect(helloAgent(id)).rejects.toBeInstanceOf(AgentNotRunningError);
    // The write met the closed peer — not a connect that already failed.
    expect(seen).toEqual(["EPIPE"]);
    await agent.exited;
  });
});
