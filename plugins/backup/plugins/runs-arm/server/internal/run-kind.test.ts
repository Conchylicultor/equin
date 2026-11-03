/**
 * The backup arm's route provenance (step 12d of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md): the columns
 * its routes gate on are EXACTLY what its SQL reads — so a write to `pid`
 * (the supervised run's heartbeat) or to `namespace` (who claimed the run)
 * reaches no runs window, `:rows` read or grouping. Compiled exactly as
 * `serveUnionCollection` compiles it, over a recording `db`.
 */

import { describe, expect, test } from "bun:test";
import { recordingQueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server/testing";
import { compileUnion } from "@plugins/network/plugins/live/server/testing";
import { runs } from "@plugins/runs/core";
import { backupRunKind } from "./run-kind";

const READ = [
  "archive_size_bytes",
  "finished_at",
  "id",
  "manifest",
  "started_at",
  "status",
  "target_results",
  "trigger",
];

describe("the backup arm's routes", () => {
  test("gate on exactly the columns its SQL reads — never pid or namespace", () => {
    const { db } = recordingQueryDb();
    const compiled = compileUnion(runs, {
      arms: () => [backupRunKind.binding],
      db,
    });
    for (const plan of [compiled.window.routes, compiled.rows.routes]) {
      const route = plan!.routes.find((r) => r.id === "backup")!;
      expect(route.table).toBe("backup_runs");
      expect([...route.columns].sort()).toEqual(READ);
    }
    for (const route of compiled.groups.reach.routes) {
      expect(route.columns).not.toContain("pid");
      expect(route.columns).not.toContain("namespace");
    }
  });
});
