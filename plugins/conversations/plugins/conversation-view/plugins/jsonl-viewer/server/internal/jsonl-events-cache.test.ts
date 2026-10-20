import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readJsonlEventsFromChain,
  transcriptChainSignature,
} from "@plugins/conversations/plugins/transcript-watcher/server";
import { createSignedMemo } from "@plugins/infra/plugins/git/plugins/git-read-cache/server";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

// The memo under test is `jsonlEventsMemo` (jsonl-events-cache.ts), whose two halves
// are `transcriptChainSignature ∘ resolve` and `readJsonlEventsFromChain ∘ resolve`.
// `resolve` is `resolveConversationTranscriptPaths`, which reads the session-chain
// table and globs the real `~/.claude/projects` — so calling `jsonlEventsMemo.get(id)`
// from a unit test would mean writing into the developer's live DB and projects dir.
//
// This suite therefore rebuilds the memo over the SAME signature/compute pair with the
// chain resolved from a temp-file fixture instead. That is the only substitution: the
// `lstat` signature, the chain read/parse, and `createSignedMemo`'s probe-then-compare
// are all the real ones, and they are what the property is about. The DB resolve is
// covered by session-chain's own real-DB suite.
//
// The load-bearing case is `prime` under a pre-append signature: the value the watcher
// hands over is stale by the time it lands, and the read path must notice. The old code
// could not — the loader read a watcher-populated `cachedEvents` map that no signature
// guarded, so the map had no way to notice the append and `mode: "push"` was the only
// reason it never surfaced. That map is gone, so this pins the property on its
// replacement rather than reproducing the old bug.

const TS = "2026-07-10T00:00:00.000Z";
const tmpFiles: string[] = [];

/** Chain id → the temp transcript files backing it, oldest → newest. */
const chains = new Map<string, string[]>();
const resolve = (id: string): Promise<string[]> =>
  Promise.resolve(chains.get(id) ?? []);

const memo = createSignedMemo<JsonlEvent[]>({
  name: "jsonl-events-test",
  signature: async (id) => transcriptChainSignature(await resolve(id)),
  compute: async (id) => readJsonlEventsFromChain(await resolve(id)),
});

const userLine = (uuid: string, parentUuid: string | null, text: string) => ({
  type: "user",
  uuid,
  parentUuid,
  timestamp: TS,
  message: { role: "user", content: text },
});

async function writeChainFile(
  lines: Record<string, unknown>[],
): Promise<string> {
  const path = join(
    tmpdir(),
    `jsonl-events-cache-test-${crypto.randomUUID()}.jsonl`,
  );
  await Bun.write(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  tmpFiles.push(path);
  return path;
}

async function appendLine(
  path: string,
  line: Record<string, unknown>,
): Promise<void> {
  const existing = await Bun.file(path).text();
  await Bun.write(path, existing + JSON.stringify(line) + "\n");
}

/** The text of each `user-text` event, in order. */
const texts = (events: JsonlEvent[]): string[] =>
  events.flatMap((e) => (e.kind === "user-text" ? [e.text] : []));

beforeEach(() => {
  for (const id of chains.keys()) memo.evict(id);
  chains.clear();
});

afterAll(async () => {
  for (const path of tmpFiles) await rm(path, { force: true });
});

describe("jsonlEventsMemo", () => {
  test("a prime under a pre-append signature does not pin", async () => {
    const path = await writeChainFile([userLine("u1", null, "first")]);
    chains.set("conv", [path]);

    // What the watcher holds when it fans out: a signature captured BEFORE the read,
    // and the events that read produced.
    const sigBefore = await transcriptChainSignature([path]);
    const eventsBefore = await readJsonlEventsFromChain([path]);
    expect(texts(eventsBefore)).toEqual(["first"]);

    // The append lands after the watcher's read — the skew window this whole change
    // exists to close.
    await appendLine(path, userLine("u2", "u1", "second"));
    memo.prime("conv", sigBefore, eventsBefore);

    // `get` re-probes the chain, finds the entry stamped with the pre-append signature,
    // misses, and recomputes. It never serves `eventsBefore` under the current ETag.
    expect(texts(await memo.get("conv"))).toEqual(["first", "second"]);
    expect(await memo.signature("conv")).not.toBe(sigBefore);
  });

  test("a prime under the current signature is a pure hit", async () => {
    const path = await writeChainFile([userLine("u1", null, "first")]);
    chains.set("conv", [path]);

    // The prime only pays off if the watcher's signature and the resource's probe are
    // byte-identical strings. They are, because both route through
    // `transcriptChainSignature` — the `lstat`-vs-`Bun.file` trap, pinned.
    const sig = await transcriptChainSignature([path]);
    memo.prime("conv", sig, [] as JsonlEvent[]);

    // A sentinel the compute could never return: an empty list for a file with a line.
    // Getting it back proves the hit ran no compute.
    expect(await memo.get("conv")).toEqual([]);
  });

  test("a session switch (chain growth) invalidates a primed entry", async () => {
    const first = await writeChainFile([userLine("u1", null, "first")]);
    chains.set("conv", [first]);

    const sigBefore = await transcriptChainSignature([first]);
    const eventsBefore = await readJsonlEventsFromChain([first]);
    memo.prime("conv", sigBefore, eventsBefore);

    // Claude relocates the live session into a new id; the chain grows a file.
    const second = await writeChainFile([userLine("u2", "u1", "second")]);
    chains.set("conv", [first, second]);

    expect(texts(await memo.get("conv"))).toEqual(["first", "second"]);
  });

  test("an unchanged chain keeps serving the memoized value", async () => {
    const path = await writeChainFile([userLine("u1", null, "first")]);
    chains.set("conv", [path]);

    const events = await memo.get("conv");
    // Same object identity: nothing re-read, nothing re-parsed.
    expect(await memo.get("conv")).toBe(events);
  });
});
