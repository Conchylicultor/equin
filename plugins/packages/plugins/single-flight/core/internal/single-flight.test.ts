import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLead } from "./single-flight";

// Every scenario here is CROSS-PROCESS, so it is driven with real child
// processes: each one is a `bun -e` snippet that calls `singleFlight` once and
// narrates what happened as JSON lines on stdout. A leader's body blocks on a
// line from its stdin, so the test decides exactly when the work "finishes" —
// and can SIGKILL a leader mid-body.

// This module, imported by the children. They run with the default cwd (inside
// the repo), so the transitive `@plugins/*` aliases resolve.
const MODULE = join(import.meta.dir, "single-flight.ts");

const CHILD = `
const { appendFileSync } = await import("node:fs");
const { z } = await import("zod");
const { singleFlight } = await import(process.env.SF_MODULE);
const say = (o) => console.log(JSON.stringify(o));
const reader = Bun.stdin.stream().getReader();
const nextLine = async () => {
  const { value } = await reader.read();
  return new TextDecoder().decode(value ?? new Uint8Array()).trim();
};
const id = process.env.SF_ID;
const flight = await singleFlight(
  {
    dir: process.env.SF_DIR,
    key: process.env.SF_KEY,
    id,
    schema: z.object({ outcome: z.string(), by: z.string() }),
    adoptable: (v) => v.outcome !== "interrupted",
    onJoin: (leader) => say({ ev: "join", leader: leader ? leader.id : null }),
  },
  async (publish) => {
    appendFileSync(process.env.SF_RUNS, id + "\\n");
    say({ ev: "lead" });
    const outcome = await nextLine();
    if (outcome !== "none") publish({ outcome, by: id });
    return id;
  },
);
say(
  flight.role === "joined"
    ? { ev: "done", role: "joined", by: flight.verdict.by, outcome: flight.verdict.outcome, leader: flight.leader.id }
    : { ev: "done", role: "led", by: flight.result },
);
process.exit(0);
`;

interface Event {
  ev: "join" | "lead" | "done";
  leader?: string | null;
  role?: "joined" | "led";
  by?: string;
  outcome?: string;
}

/** One child: its process, and a reader that yields its JSON lines in order. */
function spawnFlight(id: string, key: string) {
  const proc = Bun.spawn([process.execPath, "-e", CHILD], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      SF_MODULE: MODULE,
      SF_DIR: dir,
      SF_KEY: key,
      SF_ID: id,
      SF_RUNS: runsFile,
    },
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<Event> => {
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        return JSON.parse(line) as Event;
      }
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done && buffer.indexOf("\n") < 0)
        throw new Error(
          `flight child ${id} closed stdout before its next event`,
        );
    }
  };
  /** Wait for an event of kind `ev`, failing loudly on any other. */
  const expectEvent = async (ev: Event["ev"]): Promise<Event> => {
    const e = await next();
    if (e.ev !== ev)
      throw new Error(`child ${id}: expected ${ev}, got ${JSON.stringify(e)}`);
    return e;
  };
  const finish = (outcome: string): void => {
    void proc.stdin.write(`${outcome}\n`);
    void proc.stdin.flush();
  };
  return { id, proc, next, expectEvent, finish };
}

type Child = ReturnType<typeof spawnFlight>;

/** Ids whose body ran, in order. */
function runs(): string[] {
  return readFileSync(runsFile, "utf8").split("\n").filter(Boolean);
}

/** Start `n` joiners against an in-flight leader and wait until each is parked. */
async function joiners(n: number, key: string): Promise<Child[]> {
  const out = Array.from({ length: n }, (_, i) => spawnFlight(`j${i}`, key));
  for (const j of out) expect((await j.expectEvent("join")).leader).toBe("L");
  return out;
}

let dir: string;
let runsFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "single-flight-test-"));
  runsFile = join(dir, "runs.log");
  writeFileSync(runsFile, "");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("singleFlight (cross-process)", () => {
  test("a leader plus 5 joiners: one body runs, every joiner adopts", async () => {
    const leader = spawnFlight("L", "k");
    await leader.expectEvent("lead");
    const js = await joiners(5, "k");

    leader.finish("failed"); // a failure is a verdict too — shared as-is
    expect(await leader.expectEvent("done")).toMatchObject({
      role: "led",
      by: "L",
    });
    for (const j of js) {
      expect(await j.expectEvent("done")).toMatchObject({
        role: "joined",
        by: "L",
        outcome: "failed",
        leader: "L",
      });
    }
    await Promise.all([leader, ...js].map((c) => c.proc.exited));
    expect(runs()).toEqual(["L"]);
  }, 30_000);

  test("a SIGKILLed leader is re-led by one joiner; the rest adopt that run", async () => {
    const leader = spawnFlight("L", "k");
    await leader.expectEvent("lead");
    const js = await joiners(3, "k");

    leader.proc.kill(9);
    await leader.proc.exited;

    // Exactly one joiner wakes holding the lock with no fresh verdict, and
    // leads; the others stay parked on the lock (no second `join`) until it
    // publishes, then adopt THAT run. One pending read per joiner, so no read is
    // ever abandoned.
    const pending = js.map((j) => j.next().then((e) => ({ j, e })));
    const first = await Promise.race(pending);
    expect(first.e.ev).toBe("lead");
    first.j.finish("success");
    for (const { j, e } of await Promise.all(pending)) {
      if (j === first.j) {
        expect(await j.expectEvent("done")).toMatchObject({ role: "led" });
      } else {
        expect(e).toMatchObject({
          ev: "done",
          role: "joined",
          outcome: "success",
          by: first.j.id,
          leader: first.j.id,
        });
      }
    }
    await Promise.all(js.map((c) => c.proc.exited));
    expect(runs()).toHaveLength(2);
    expect(runs()[0]).toBe("L");
  }, 30_000);

  test("a non-adoptable verdict makes the joiner run the work itself", async () => {
    const leader = spawnFlight("L", "k");
    await leader.expectEvent("lead");
    const [j] = await joiners(1, "k");

    leader.finish("interrupted"); // published, but `adoptable` says no
    await leader.expectEvent("done");
    await j!.expectEvent("lead");
    j!.finish("success");
    expect(await j!.expectEvent("done")).toMatchObject({ role: "led" });
    await Promise.all([leader.proc.exited, j!.proc.exited]);
    expect(runs()).toEqual(["L", "j0"]);
  }, 30_000);

  test("a leader that publishes nothing leaves the joiner to lead", async () => {
    const leader = spawnFlight("L", "k");
    await leader.expectEvent("lead");
    const [j] = await joiners(1, "k");

    leader.finish("none");
    await leader.expectEvent("done");
    await j!.expectEvent("lead");
    j!.finish("success");
    await j!.expectEvent("done");
    await Promise.all([leader.proc.exited, j!.proc.exited]);
    expect(runs()).toEqual(["L", "j0"]);
  }, 30_000);

  test("a verdict published before the joiner arrived is never adopted", async () => {
    // An earlier leader leaves an adoptable verdict on disk.
    const old = spawnFlight("old", "k");
    await old.expectEvent("lead");
    old.finish("success");
    await old.expectEvent("done");
    await old.proc.exited;

    // A new leader takes the lock and dies before publishing anything; the
    // joiner that arrived meanwhile finds only the OLD verdict and must re-run.
    const leader = spawnFlight("L", "k");
    await leader.expectEvent("lead");
    const [j] = await joiners(1, "k");
    leader.proc.kill(9);
    await leader.proc.exited;

    await j!.expectEvent("lead");
    j!.finish("failed");
    expect(await j!.expectEvent("done")).toMatchObject({ role: "led" });
    await j!.proc.exited;
    expect(runs()).toEqual(["old", "L", "j0"]);
  }, 30_000);

  test("tryLead never waits: busy while the key is in flight, leads once it is free", async () => {
    const leader = spawnFlight("L", "k");
    await leader.expectEvent("lead");
    let ran = false;
    const busy = await tryLead({ dir, key: "k", id: "T" }, async () => {
      ran = true;
    });
    expect(busy).toEqual({ role: "busy" });
    expect(ran).toBe(false);

    leader.finish("success");
    await leader.expectEvent("done");
    await leader.proc.exited;
    const led = await tryLead<{ outcome: string; by: string }, string>(
      { dir, key: "k", id: "T" },
      async (publish) => {
        publish({ outcome: "success", by: "T" });
        return "T";
      },
    );
    expect(led).toEqual({ role: "led", result: "T" });
  }, 30_000);

  test("different keys run in parallel", async () => {
    const a = spawnFlight("A", "key-a");
    const b = spawnFlight("B", "key-b");
    // Both lead at once: neither waits for the other.
    await Promise.all([a.expectEvent("lead"), b.expectEvent("lead")]);
    a.finish("success");
    b.finish("success");
    await Promise.all([a.expectEvent("done"), b.expectEvent("done")]);
    await Promise.all([a.proc.exited, b.proc.exited]);
    expect(runs().sort()).toEqual(["A", "B"]);
    // One file triple per key, named by the key's hash.
    const sha = (k: string) => createHash("sha256").update(k).digest("hex");
    expect(
      readFileSync(join(dir, `${sha("key-a")}.verdict.json`), "utf8"),
    ).toContain('"by":"A"');
    expect(
      readFileSync(join(dir, `${sha("key-b")}.verdict.json`), "utf8"),
    ).toContain('"by":"B"');
  }, 30_000);
});
