import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTicketLine, type Ticket } from "./ticket-line";

// The line is cross-process by construction (flocks are per open file
// description, so two tickets of ONE process exclude each other exactly as two
// processes' do), so most scenarios run in-process; the crash case uses a real
// child that is SIGKILLed while it holds the head.

const MODULE = join(import.meta.dir, "ticket-line.ts");

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "ticket-line-")), "line");
});
afterEach(() => {
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

/** Resolves to the ticket once at the head; `state()` says whether it has. */
function track(p: Promise<Ticket>): {
  ticket: Promise<Ticket>;
  state: () => "waiting" | "head";
} {
  let head = false;
  void p.then(() => {
    head = true;
  });
  return { ticket: p, state: () => (head ? "head" : "waiting") };
}

/** Give flock-wait children time to be granted (a few process round trips). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

/** The message a promise rejects with (fails the test if it resolves). */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Error) return err.message;
    throw err;
  }
  throw new Error("expected a rejection");
}

const tickets = (): string[] =>
  readdirSync(dir).filter((n) => n.startsWith("t-"));

describe("createTicketLine", () => {
  test("an empty line admits at once and isEmpty reflects the holder", async () => {
    const line = createTicketLine(dir);
    expect(line.isEmpty()).toBe(true);
    const t = await line.join();
    expect(line.isEmpty()).toBe(false);
    t.leave();
    expect(line.isEmpty()).toBe(true);
    expect(tickets()).toEqual([]);
  });

  test("waiters reach the head in arrival order, one per leave", async () => {
    const line = createTicketLine(dir);
    const a = await line.join();
    const b = track(line.join());
    await settle();
    const c = track(line.join());
    await settle();
    expect([b.state(), c.state()]).toEqual(["waiting", "waiting"]);

    a.leave();
    await settle();
    expect([b.state(), c.state()]).toEqual(["head", "waiting"]);

    (await b.ticket).leave();
    await settle();
    expect(c.state()).toBe("head");
    (await c.ticket).leave();
  });

  test("a waiter that abandons its place hands it on without reordering", async () => {
    const line = createTicketLine(dir);
    const a = await line.join();
    const abort = new AbortController();
    const b = line.join({ signal: abort.signal });
    await settle();
    const c = track(line.join());
    await settle();

    abort.abort(new Error("gave up"));
    expect(await rejection(b)).toBe("gave up");
    await settle();
    // C now waits on A, the live ticket ahead of it — not the head yet.
    expect(c.state()).toBe("waiting");

    a.leave();
    await settle();
    expect(c.state()).toBe("head");
    (await c.ticket).leave();
    expect(tickets()).toEqual([]);
  });

  test("a SIGKILLed head frees its place; its file is reaped", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { createTicketLine } = await import(process.env.TL_MODULE);
         await createTicketLine(process.env.TL_DIR).join();
         console.log("head");
         await new Promise(() => {});`,
      ],
      {
        env: { ...process.env, TL_MODULE: MODULE, TL_DIR: dir },
        stdout: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("head");

    const line = createTicketLine(dir);
    const me = track(line.join());
    await settle();
    expect(me.state()).toBe("waiting");

    child.kill(9);
    await child.exited;
    await settle();
    expect(me.state()).toBe("head");
    (await me.ticket).leave();
    expect(tickets()).toEqual([]);
  });

  test("isEmpty reaps a ticket nobody holds", async () => {
    const line = createTicketLine(dir);
    const t = await line.join();
    const [name] = tickets();
    // Simulate an owner that died between its unlink and its close: the file
    // stays, the lock goes.
    t.leave();
    await Bun.write(join(dir, name ?? "missing"), "");
    expect(tickets()).toHaveLength(1);
    expect(line.isEmpty()).toBe(true);
    expect(tickets()).toEqual([]);
  });

  test("an already-aborted join takes no ticket", async () => {
    const line = createTicketLine(dir);
    const abort = new AbortController();
    abort.abort(new Error("stop"));
    expect(await rejection(line.join({ signal: abort.signal }))).toBe("stop");
    expect(line.isEmpty()).toBe(true);
  });
});
