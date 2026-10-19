/**
 * `agent-thread.runs`, compiled from its REAL declaration and options against
 * a recording `QueryDb` (no database): the scratch-only base membership, the
 * profile filter over the joined attempt's spec, and the attempt route's gate.
 *
 * Run: `./singularity test plugins/conversations/plugins/agent-thread`.
 */

import { describe, expect, test } from "bun:test";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import {
  compileWindowQuery,
  recordingQueryDb,
} from "@plugins/infra/plugins/query-resource/server/testing";
import { threadRuns } from "../../core";
import { threadRunsServeOptions } from "./runs";

function compile() {
  const recording = recordingQueryDb();
  const specs = compileCollection(threadRuns, {
    ...threadRunsServeOptions,
    db: recording.db,
  });
  return {
    window: compileWindowQuery(threadRuns.window, specs.window).serverOpts,
    ...recording,
  };
}

const w = threadRuns.window.window;

describe("agent-thread.runs", () => {
  test("keeps scratch attempts only, and filters by the spec's profile", async () => {
    const { window, calls } = compile();
    await window.loader(
      w.encode({ where: { profile: { eq: "places.find" } } }),
    );
    const { sql, params } = calls.at(-1)!;
    expect(sql).toContain(`->> 'kind') = 'scratch'`);
    expect(sql).toContain(`->> 'profile')`);
    expect(params).toContain("places.find");
  });

  test("an attempt write reaches a tuple only through the columns it reads", () => {
    const { window } = compile();
    const routes = window.routes!.routes;
    expect(routes.map((r) => [r.id, r.table, r.map.kind])).toEqual([
      ["base", "conversations", "identity"],
      ["attempt", "attempts", "reverse"],
    ]);
    const attempt = routes.find((r) => r.id === "attempt")!;
    expect([...attempt.columns].sort()).toEqual(["id", "task_id", "workspace"]);
  });
});
