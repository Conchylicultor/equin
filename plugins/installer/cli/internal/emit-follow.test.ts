import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core/testing";
import {
  enterBuildSubStep,
  finishBuildSubSteps,
  followableBy,
  reportInstallProgress,
  requestFollow,
} from "./emit";

// One scenario per file: emit.ts keeps the build's sub-step state per process.
// The install's FIFO is stood in for by a plain file (opened the same way).

function events(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const {
        v: _v,
        t: _t,
        ...rest
      } = JSON.parse(l) as Record<string, unknown>;
      return rest;
    });
}

describe("a followed build", () => {
  test("tells an install that asked mid-build what it missed, then the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "install-follow-"));
    const request = join(dir, "install-follow.json");
    const stream = join(dir, "events");
    writeFileSync(stream, "");

    await withEnv(
      { INSTALL_EVENTS: undefined, INSTALL_STEP: undefined },
      () => {
        followableBy(request);
        // Nobody follows yet: tracked, told no one.
        enterBuildSubStep("build.database");
        Bun.sleepSync(30);
        enterBuildSubStep("build.deps");
        expect(events(stream)).toEqual([]);

        // The install's build step asks (as `requestFollow` writes it),
        // after the database sub-step ended: that time was its earlier
        // steps', never its own.
        Bun.sleepSync(5);
        writeFileSync(
          request,
          JSON.stringify({
            events: stream,
            pid: process.pid,
            since: Date.now(),
          }),
        );
        reportInstallProgress(5, 10, "packages");
        enterBuildSubStep("build.interface");
        finishBuildSubSteps(true);
        // Done: a later sub-step is told no one.
        reportInstallProgress(1, 1, "plugins");
      },
    );

    const database = events(stream).find(
      (e) => e.id === "build.database" && e.state === "done",
    );
    expect(database?.ms).toBe(0);
    const got = events(stream).map((e) =>
      "ms" in e ? { ...e, ms: typeof e.ms } : e,
    );
    expect(got).toEqual([
      { type: "wait", step: "build", state: "end", on: "lock" },
      { type: "step", id: "build.database", state: "start" },
      { type: "step", id: "build.database", state: "done", ms: "number" },
      { type: "step", id: "build.deps", state: "start" },
      {
        type: "progress",
        id: "build.deps",
        done: 5,
        total: 10,
        unit: "packages",
      },
      { type: "step", id: "build.deps", state: "done", ms: "number" },
      { type: "step", id: "build.codegen", state: "skipped" },
      { type: "step", id: "build.interface", state: "start" },
      { type: "step", id: "build.interface", state: "done", ms: "number" },
      { type: "step", id: "build.deploy", state: "skipped" },
    ]);
    // The waiter learns its step was shown.
    expect(JSON.parse(readFileSync(request, "utf8")).followedBy).toBe(
      process.pid,
    );
  });

  test("requestFollow writes the request and its withdrawal says whether a build took it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "install-follow-"));
    const request = join(dir, "nested", "install-follow.json");
    await withEnv({ INSTALL_EVENTS: join(dir, "events.fifo") }, () => {
      const untaken = requestFollow(request);
      expect(JSON.parse(readFileSync(request, "utf8"))).toEqual({
        events: join(dir, "events.fifo"),
        pid: process.pid,
        since: expect.any(Number),
      });
      expect(untaken()).toEqual({ followed: false });

      const taken = requestFollow(request);
      const read = JSON.parse(readFileSync(request, "utf8")) as object;
      writeFileSync(request, JSON.stringify({ ...read, followedBy: 1 }));
      expect(taken()).toEqual({ followed: true });
    });
  });
});
