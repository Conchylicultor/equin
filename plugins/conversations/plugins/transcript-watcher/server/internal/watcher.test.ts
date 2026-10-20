import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only: erased at runtime, so it does not load `./watcher` ahead of the mocks.
import type { TranscriptSnapshot } from "./watcher";

// The room resolver is the watcher's only DB dependency; stub it so the tests
// exercise the real signature, the real chain reader, and the real `processRoom`
// over real files. Bun scopes module mocks to the test file, so `parse-jsonl.test.ts`
// still sees the genuine module.
let chainPaths: string[] = [];
void mock.module("./resolve-chain", () => ({
  resolveConversationTranscriptPaths: () => Promise.resolve(chainPaths),
}));

// Wrap the real chain reader with a hook that runs INSIDE the read. That is the only
// way to land a filesystem change strictly between `processRoom`'s signature probe
// and its read — the interleaving the ordering contract is about.
const parseJsonl = await import("./parse-jsonl");
const realReadChain = parseJsonl.readJsonlEventsFromChain;
let duringRead: (() => Promise<void>) | null = null;
void mock.module("./parse-jsonl", () => ({
  readChainLines: parseJsonl.readChainLines,
  readJsonlEvents: parseJsonl.readJsonlEvents,
  readJsonlEventsFromChain: async (paths: string[]) => {
    const hook = duringRead;
    duringRead = null;
    await hook?.();
    return realReadChain(paths);
  },
}));

const { watchTranscript, refreshConversationChain } = await import("./watcher");
const { transcriptChainSignature } = await import("./chain-signature");

let seq = 0;
function line(text: string): string {
  seq += 1;
  return `${JSON.stringify({
    type: "user",
    uuid: `u${seq}`,
    parentUuid: seq > 1 ? `u${seq - 1}` : null,
    timestamp: `2026-07-10T00:00:0${seq}.000Z`,
    message: { role: "user", content: text },
  })}\n`;
}

/** Collects fan-outs and lets a test await the next one. */
function collector() {
  const snapshots: TranscriptSnapshot[] = [];
  const waiters: (() => void)[] = [];
  return {
    snapshots,
    listen: (s: TranscriptSnapshot) => {
      snapshots.push(s);
      for (const w of waiters.splice(0)) w();
    },
    next: (): Promise<void> =>
      new Promise((resolve) => {
        waiters.push(resolve);
      }),
  };
}

describe("processRoom", () => {
  let dir: string;
  let transcript: string;
  let convId: string;
  const unsubscribes: (() => void)[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "transcript-watcher-"));
    transcript = join(dir, "session-a.jsonl");
    convId = `conv-${Math.random().toString(36).slice(2)}`;
    chainPaths = [transcript];
    duringRead = null;
    seq = 0;
  });

  afterEach(async () => {
    for (const un of unsubscribes.splice(0)) un();
    await rm(dir, { recursive: true, force: true });
  });

  function subscribe(c: ReturnType<typeof collector>): void {
    unsubscribes.push(watchTranscript(convId, c.listen));
  }

  test("the fanned-out signature describes a snapshot no newer than the fanned-out events", async () => {
    await writeFile(transcript, line("first"));
    const sigBefore = await transcriptChainSignature(chainPaths);

    // Append from inside the read: the events will contain the appended line, the
    // signature was captured before it landed.
    duringRead = () => appendFile(transcript, line("second"));

    const c = collector();
    const fanned = c.next();
    subscribe(c);
    await fanned;

    const sigAfter = await transcriptChainSignature(chainPaths);
    expect(sigAfter).not.toBe(sigBefore);

    const snapshot = c.snapshots[0]!;
    expect(snapshot.events).toHaveLength(2);
    // Older is fine (one needless recompute); newer would pin a stale value forever.
    expect(snapshot.signature).toBe(sigBefore);
    expect(snapshot.signature).not.toBe(sigAfter);
  });

  test("a re-fanned identical chain is deduped by signature", async () => {
    await writeFile(transcript, line("first"));

    const c = collector();
    const fanned = c.next();
    subscribe(c);
    await fanned;
    expect(c.snapshots).toHaveLength(1);

    await refreshConversationChain(convId);
    expect(c.snapshots).toHaveLength(1);
  });

  test("an append re-fans with the grown events and the grown signature", async () => {
    await writeFile(transcript, line("first"));

    const c = collector();
    const first = c.next();
    subscribe(c);
    await first;

    await appendFile(transcript, line("second"));
    await refreshConversationChain(convId);

    expect(c.snapshots).toHaveLength(2);
    const before = c.snapshots[0]!;
    const after = c.snapshots[1]!;
    expect(before.events).toHaveLength(1);
    expect(after.events).toHaveLength(2);
    expect(after.signature).toBe(await transcriptChainSignature(chainPaths));
    expect(after.signature).not.toBe(before.signature);
  });

  test("a chain that grows a session file re-fans", async () => {
    await writeFile(transcript, line("first"));

    const c = collector();
    const first = c.next();
    subscribe(c);
    await first;

    const second = join(dir, "session-b.jsonl");
    await writeFile(second, line("switched"));
    chainPaths = [transcript, second];
    await refreshConversationChain(convId);

    expect(c.snapshots).toHaveLength(2);
    expect(c.snapshots[1]!.events).toHaveLength(2);
  });

  test("a failed read does not record its signature, so the next process retries", async () => {
    await writeFile(transcript, line("first"));

    const c = collector();
    const first = c.next();
    subscribe(c);
    await first;

    await appendFile(transcript, line("second"));
    duringRead = () => Promise.reject(new Error("transient read failure"));
    await refreshConversationChain(convId);
    // Swallowed by the per-room boundary; nothing fanned out, and — the point — the
    // appended chain's signature was NOT recorded.
    expect(c.snapshots).toHaveLength(1);

    // Nothing moved on disk since the failure. A room that had recorded the
    // signature before the read (the old mtime map) would short-circuit here and
    // drop the appended event until the next write.
    await refreshConversationChain(convId);
    expect(c.snapshots).toHaveLength(2);
    expect(c.snapshots[1]!.events).toHaveLength(2);
  });

  test("a late subscriber receives the events and their signature as one pair", async () => {
    await writeFile(transcript, line("first"));

    const first = collector();
    const fanned = first.next();
    subscribe(first);
    await fanned;

    const late = collector();
    const delivered = late.next();
    subscribe(late);
    await delivered;

    expect(late.snapshots[0]).toEqual(first.snapshots[0]!);
    expect(late.snapshots[0]!.signature).toBe(await transcriptChainSignature(chainPaths));
  });
});
