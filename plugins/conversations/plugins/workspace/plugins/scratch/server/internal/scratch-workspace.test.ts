import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  defineScratchProfile,
  ScratchProfile,
} from "@plugins/conversations/plugins/workspace/server";
import { resetScratchProfiles } from "@plugins/conversations/plugins/workspace/server/testing";
import { createScratchWorkspace } from "./scratch-workspace";

const trusted: string[] = [];
const scratchWorkspace = createScratchWorkspace({
  assertTrusted: (dir) => trusted.push(dir),
});

const order: string[] = [];
const profile = defineScratchProfile({
  id: "test.scratch",
  description: "test",
  inputSchema: z.object({ note: z.string().default("hi") }),
  instructions: (input) => `# note\n${input.note}`,
  mcpTools: [],
  async prepare({ dir, input }) {
    // The instructions are already on disk when the profile prepares.
    order.push(await readFile(join(dir, "CLAUDE.md"), "utf8"));
    order.push(`prepare:${input.note}`);
  },
});

const tmp = await mkdtemp(join(tmpdir(), "scratch-workspace-test-"));
afterAll(() => rm(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  resetScratchProfiles();
  order.length = 0;
  await ScratchProfile.define(profile).register();
});

describe("scratchWorkspace.parseSpec", () => {
  test("stores the input as its profile parses it", () => {
    expect(
      scratchWorkspace.parseSpec({
        kind: "scratch",
        profile: "test.scratch",
        input: {},
      }),
    ).toEqual({
      kind: "scratch",
      profile: "test.scratch",
      input: { note: "hi" },
    });
  });

  test("an input the profile refuses throws", () => {
    expect(() =>
      scratchWorkspace.parseSpec({
        kind: "scratch",
        profile: "test.scratch",
        input: { note: 3 },
      }),
    ).toThrow();
  });

  test("an unknown profile throws", () => {
    expect(() =>
      scratchWorkspace.parseSpec({
        kind: "scratch",
        profile: "nope",
        input: {},
      }),
    ).toThrow('Unknown scratch profile "nope"');
  });
});

describe("scratchWorkspace.prepare", () => {
  test("writes CLAUDE.md, then runs the profile's prepare; idempotent", async () => {
    const path = join(tmp, "att-1");
    const at = {
      attemptId: "att-1",
      path,
      spec: {
        kind: "scratch" as const,
        profile: "test.scratch",
        input: { note: "x" },
      },
    };
    await scratchWorkspace.prepare(at, new AbortController().signal);
    await scratchWorkspace.prepare(at, new AbortController().signal);
    expect(order).toEqual(["# note\nx", "prepare:x", "# note\nx", "prepare:x"]);
    // The trust of the session's cwd is asserted before anything is written.
    expect(trusted).toEqual([path, path]);
  });
});

describe("scratchWorkspace.checkResumable", () => {
  test("a gone dir is refused with its own message", () => {
    const resumable = scratchWorkspace.checkResumable({
      attemptId: "att-gone",
      path: join(tmp, "att-gone"),
      spec: { kind: "scratch", profile: "test.scratch", input: {} },
    });
    expect(resumable.kind).toBe("missing");
  });
});
