import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sanitizeChannel } from "@plugins/infra/plugins/file-sink/core";
import { worktreesDir } from "@plugins/infra/plugins/paths/server";
import { logsDirFor, readChannelJson } from "./persist";

// Hermetic: a throwaway worktree name under the real SINGULARITY_DIR (mirrors
// host-semaphore's test precedent), removed in afterEach. The WRITE/rotation
// path moved to file-sink, so we seed real log-channel envelope lines directly
// on disk (the `{t,stream,line}` JSONL shape) at the same path readChannelJson
// reconstructs — exercising the read path end-to-end (envelope unwrap + inner
// JSON.parse + safeParse).

const CHANNEL = "sample";
const Schema = z.object({ n: z.number() });

let worktree: string;

beforeEach(() => {
  worktree = `read-channel-json-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
  rmSync(join(worktreesDir(), worktree), { recursive: true, force: true });
});

function envelope(line: string): string {
  return JSON.stringify({ t: Date.now(), stream: "stdout", line });
}

// Seed the channel's live `.jsonl` file with envelope lines wrapping each raw
// inner payload string, at the exact path readChannelEntries reconstructs.
function seed(innerLines: string[]): void {
  const dir = logsDirFor(worktree);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, sanitizeChannel(CHANNEL) + ".jsonl"),
    innerLines.map(envelope).join("\n") + "\n",
  );
}

describe("readChannelJson", () => {
  test("unwraps the envelope and returns schema-valid payloads", () => {
    seed([JSON.stringify({ n: 1 }), JSON.stringify({ n: 2 })]);
    expect(readChannelJson(worktree, CHANNEL, 100, Schema)).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
  });

  test("drops a torn inner-JSON line and keeps the rest", () => {
    // The middle payload is not valid JSON (a half-flushed inner append).
    seed([JSON.stringify({ n: 1 }), '{"n":', JSON.stringify({ n: 3 })]);
    expect(readChannelJson(worktree, CHANNEL, 100, Schema)).toEqual([
      { n: 1 },
      { n: 3 },
    ]);
  });

  test("drops schema-invalid payloads (old shape / wrong type)", () => {
    seed([
      JSON.stringify({ n: 1 }),
      JSON.stringify({ n: "not-a-number" }),
      JSON.stringify({ other: true }),
    ]);
    expect(readChannelJson(worktree, CHANNEL, 100, Schema)).toEqual([{ n: 1 }]);
  });

  test("missing channel collapses to []", () => {
    expect(readChannelJson(worktree, "never-written", 100, Schema)).toEqual([]);
  });
});
