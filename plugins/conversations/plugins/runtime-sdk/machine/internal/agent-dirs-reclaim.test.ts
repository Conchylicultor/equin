import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  reclaimAttemptAgentDirs,
  sweepReclaimedAgentDirs,
  type AgentDirFacts,
  type AgentDirRoots,
} from "./agent-dirs-reclaim";

const OWN = "main-ns";
// Above any pid macOS or Linux hands out.
const DEAD_PID = "99999999";

let root: AppPath;
let roots: AgentDirRoots;

beforeEach(() => {
  root = asAppPath(mkdtempSync(join(tmpdir(), "agent-dirs-reclaim-")));
  roots = {
    agentsRoot: joinAppPath(root, "state"),
    pidsRoot: joinAppPath(root, "locks"),
    ownNamespace: OWN,
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function agentDir(ns: string, id: string): string {
  const dir = join(roots.agentsRoot, ns, id);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), '{"seq":1}\n');
  return dir;
}

function pidFile(ns: string, id: string, text: string): string {
  mkdirSync(join(roots.pidsRoot, ns), { recursive: true });
  const path = join(roots.pidsRoot, ns, `${id}.pid`);
  writeFileSync(path, text);
  return path;
}

/** conversation → attempt, and attempt → workspace on disk; anything unlisted is unknown to the DB. */
function factsOf(
  conversations: Record<string, string>,
  workspaces: Record<string, boolean>,
): AgentDirFacts {
  return {
    attemptsOfConversations: (ids) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id) =>
            conversations[id] ? [[id, conversations[id]] as const] : [],
          ),
        ),
      ),
    conversationsOfAttempts: (attemptIds) =>
      Promise.resolve(
        Object.keys(conversations).filter((c) =>
          attemptIds.includes(conversations[c]!),
        ),
      ),
    workspacePresent: (attemptIds) =>
      Promise.resolve(
        new Map(
          attemptIds.flatMap((a) =>
            a in workspaces ? [[a, workspaces[a]!] as const] : [],
          ),
        ),
      ),
  };
}

describe("reclaimAttemptAgentDirs (the announcement)", () => {
  test("removes the attempt's conversations here and its own namespace, but no other", async () => {
    const mine = agentDir(OWN, "conv-a");
    const other = agentDir(OWN, "conv-b");
    const testing = agentDir("att-1", "conv-t");
    const stale = pidFile("att-1", "conv-t", DEAD_PID);
    const facts = factsOf({ "conv-a": "att-1", "conv-b": "att-2" }, {});

    const r = await reclaimAttemptAgentDirs(["att-1"], roots, facts);

    expect(r.removed).toBe(2);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(testing)).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(roots.agentsRoot, "att-1"))).toBe(false);
    expect(existsSync(join(roots.pidsRoot, "att-1"))).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  test("keeps a running agent's directory, and its namespace with it", async () => {
    const running = agentDir("att-1", "conv-t");
    pidFile("att-1", "conv-t", `${String(process.pid)}\naccount`);
    const r = await reclaimAttemptAgentDirs(["att-1"], roots, factsOf({}, {}));
    expect(r).toMatchObject({ removed: 0, live: 1, namespacesRemoved: 0 });
    expect(existsSync(running)).toBe(true);
  });

  test("an attempt with nothing here is a no-op", async () => {
    const r = await reclaimAttemptAgentDirs(["att-9"], roots, factsOf({}, {}));
    expect(r.removed).toBe(0);
  });
});

describe("sweepReclaimedAgentDirs (the backstop)", () => {
  test("removes dirs whose workspace is gone; keeps present, unknown and running", async () => {
    const gone = agentDir(OWN, "conv-gone");
    const present = agentDir(OWN, "conv-present");
    const noRow = agentDir(OWN, "conv-no-row");
    const running = agentDir(OWN, "conv-running");
    pidFile(OWN, "conv-running", String(process.pid));
    const facts = factsOf(
      {
        "conv-gone": "att-gone",
        "conv-present": "att-here",
        "conv-running": "att-gone",
      },
      { "att-gone": false, "att-here": true },
    );

    const r = await sweepReclaimedAgentDirs(roots, facts, { dryRun: false });

    expect(r).toEqual({
      removed: 1,
      live: 1,
      present: 1,
      unknown: 1,
      namespacesRemoved: 0,
    });
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(present)).toBe(true);
    expect(existsSync(noRow)).toBe(true);
    expect(existsSync(running)).toBe(true);
  });

  test("a checkout's namespace goes with its workspace; an unknown one stays; an empty one goes", async () => {
    agentDir("att-gone", "conv-x");
    const kept = agentDir("sonata.att-1", "conv-y");
    mkdirSync(join(roots.agentsRoot, "att-empty"), { recursive: true });
    const facts = factsOf({}, { "att-gone": false, "att-empty": true });

    const r = await sweepReclaimedAgentDirs(roots, facts, { dryRun: false });

    expect(r).toMatchObject({ removed: 1, unknown: 1, namespacesRemoved: 2 });
    expect(existsSync(join(roots.agentsRoot, "att-gone"))).toBe(false);
    expect(existsSync(join(roots.agentsRoot, "att-empty"))).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  test("a workspace back by the time its directory is reached is kept", async () => {
    const dir = agentDir(OWN, "conv-a");
    let reads = 0;
    const facts: AgentDirFacts = {
      ...factsOf({ "conv-a": "att-1" }, {}),
      // Gone at the first read, back when asked again just before removal.
      workspacePresent: (ids) =>
        Promise.resolve(new Map(ids.map((id) => [id, reads++ > 0] as const))),
    };

    const r = await sweepReclaimedAgentDirs(roots, facts, { dryRun: false });

    expect(r).toMatchObject({ removed: 0, present: 1 });
    expect(existsSync(dir)).toBe(true);
  });

  test("a dry run counts the same and deletes nothing", async () => {
    const gone = agentDir(OWN, "conv-gone");
    const ns = agentDir("att-gone", "conv-x");
    const facts = factsOf({ "conv-gone": "att-gone" }, { "att-gone": false });

    const r = await sweepReclaimedAgentDirs(roots, facts, { dryRun: true });

    expect(r).toMatchObject({ removed: 2, namespacesRemoved: 1 });
    expect(existsSync(gone)).toBe(true);
    expect(existsSync(ns)).toBe(true);
  });

  test("no agents root is nothing to sweep", async () => {
    const r = await sweepReclaimedAgentDirs(roots, factsOf({}, {}), {
      dryRun: false,
    });
    expect(r).toEqual({
      removed: 0,
      live: 0,
      present: 0,
      unknown: 0,
      namespacesRemoved: 0,
    });
  });
});
