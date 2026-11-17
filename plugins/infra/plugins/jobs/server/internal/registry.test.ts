import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { assertDefinedJobsRegistered, defineJob } from "./registry";

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

// The enqueue refusal above fires only when something enqueues — on main, for
// `task-title.generate` (2026-11-17). The serving backend asks once its
// register phase is over, so the worktree that made the mistake fails to boot.
describe("assertDefinedJobsRegistered", () => {
  const spec = {
    description: "A test job.",
    hold: "instant",
    input: z.object({}).default({}),
    event: z.never(),
    dedup: "none",
    run: async () => {},
  } as const;

  // This process holds every suite's fixtures, so the assertion is on the
  // names, never on whether it throws at all.
  function unregisteredNames(): string {
    try {
      assertDefinedJobsRegistered();
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  }

  test("names a defined job no plugin registered, and the register list", () => {
    defineJob({ ...spec, name: "jobs.registry-test.never-listed" });
    expect(unregisteredNames()).toMatch(
      /defined but not registered: .*jobs\.registry-test\.never-listed.*`register` list/,
    );
  });

  test("a registered job is not named", async () => {
    await defineJob({ ...spec, name: "jobs.registry-test.listed" }).register();
    expect(unregisteredNames()).not.toContain("jobs.registry-test.listed");
  });

  test("a second factory under a registered name is named", async () => {
    await defineJob({ ...spec, name: "jobs.registry-test.taken" }).register();
    defineJob({ ...spec, name: "jobs.registry-test.taken" });
    expect(unregisteredNames()).toContain("jobs.registry-test.taken");
  });
});
