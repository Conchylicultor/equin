import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineJob } from "./registry";

// A runner resolves a row's handler by name from its own registry, so a row
// queued for a job no plugin registered is an "unknown job" on every runner
// (2026-11-16: `conversations.usage.scan-keys`, defined and enqueued but left
// out of its plugin's `register` list, dead-lettered on every main boot).
// `enqueue` refuses it at the caller instead, before any queue is touched.
describe("enqueue of a job no plugin registered", () => {
  const spec = {
    description: "A test job.",
    hold: "instant",
    input: z.object({}).default({}),
    event: z.never(),
    dedup: "none",
    run: async () => {},
  } as const;

  test("throws, naming the job and the register list", () => {
    const job = defineJob({ ...spec, name: "jobs.registry-test.unregistered" });
    expect(job.enqueue({})).rejects.toThrow(
      /jobs\.registry-test\.unregistered is enqueued but not registered.*`register` list/,
    );
  });

  test("a second factory under a registered name is refused too", async () => {
    await defineJob({
      ...spec,
      name: "jobs.registry-test.shadowed",
    }).register();
    const shadow = defineJob({ ...spec, name: "jobs.registry-test.shadowed" });
    expect(shadow.enqueue({})).rejects.toThrow(/not registered/);
  });
});
