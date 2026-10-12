import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import {
  BUILD_RUN_KIND_ID,
  buildRunIdKind,
  type BuildRunId,
} from "@plugins/build/plugins/run-ledger/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import { buildRunIdOfMarker, createRunTerminalHub } from "./run-terminal";

/** The marker filename the shim writes for one run of `kindId`. */
function markerName(kindId: string, runId: string): string {
  return basename(
    worktreeArtifacts.runTerminal(asNamespace("att-test"), kindId, runId),
  );
}

describe("buildRunIdOfMarker", () => {
  test("inverts the marker path for a build run", () => {
    const runId = buildRunIdKind.mint();
    expect(buildRunIdOfMarker(markerName(BUILD_RUN_KIND_ID, runId))).toBe(
      runId,
    );
  });

  test("another kind's marker is not a build's", () => {
    expect(
      buildRunIdOfMarker(markerName("release", buildRunIdKind.mint())),
    ).toBeNull();
  });

  test("a build transcript, a temp file or a non-id stem is not a marker", () => {
    const runId = buildRunIdKind.mint();
    expect(buildRunIdOfMarker(`${BUILD_RUN_KIND_ID}-${runId}.log`)).toBeNull();
    expect(
      buildRunIdOfMarker(`${markerName(BUILD_RUN_KIND_ID, runId)}.tmp.123`),
    ).toBeNull();
    expect(buildRunIdOfMarker(markerName(BUILD_RUN_KIND_ID, "x"))).toBeNull();
  });
});

describe("createRunTerminalHub", () => {
  const run = buildRunIdKind.mint();

  test("arms once, before the first subscriber resolves", async () => {
    let arms = 0;
    let armedWhenResolved = false;
    const hub = createRunTerminalHub(async () => {
      await Promise.resolve();
      arms++;
    });
    await hub
      .on(() => undefined)
      .then(() => {
        armedWhenResolved = arms === 1;
      });
    await hub.on(() => undefined);
    expect(armedWhenResolved).toBe(true);
    expect(arms).toBe(1);
  });

  test("announces to every listener until it unsubscribes", async () => {
    const hub = createRunTerminalHub(() => Promise.resolve());
    const heard: [string, BuildRunId][] = [];
    const offA = await hub.on((id) => heard.push(["a", id]));
    await hub.on((id) => heard.push(["b", id]));
    hub.announce(run);
    offA();
    hub.announce(run);
    expect(heard).toEqual([
      ["a", run],
      ["b", run],
      ["b", run],
    ]);
  });

  test("a failed arm rejects, drops the listener, and is retried next time", async () => {
    let attempt = 0;
    const hub = createRunTerminalHub(async () => {
      attempt++;
      if (attempt === 1) throw new Error("watcher refused");
    });
    let heardFailed = false;
    let error: unknown = null;
    try {
      await hub.on(() => {
        heardFailed = true;
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    let heard = false;
    await hub.on(() => {
      heard = true;
    });
    expect(attempt).toBe(2);
    hub.announce(run);
    expect(heard).toBe(true);
    expect(heardFailed).toBe(false);
  });

  test("a throwing listener does not starve the others, and still throws", async () => {
    const hub = createRunTerminalHub(() => Promise.resolve());
    let heard = false;
    await hub.on(() => {
      throw new Error("listener bug");
    });
    await hub.on(() => {
      heard = true;
    });
    expect(() => hub.announce(run)).toThrow("listener bug");
    expect(heard).toBe(true);
  });
});
