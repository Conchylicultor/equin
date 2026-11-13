import { expect, test } from "bun:test";
import { resolve } from "path";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { migrationDataIn, schemaMigrationFilesIn } from "./migration-data";
import { MIGRATIONS_DATA_DIR } from "./published";
import { schemaMigrationFiles } from "./schema-snapshot";

// The schema-migration predicate read through a check's file set answers what
// the disk one does, over the real data dir.
test("schemaMigrationFilesIn over the checkout's set equals schemaMigrationFiles on disk", async () => {
  const repo = await loadRepoSnapshot(REPO_ROOT);
  const viaSet = await schemaMigrationFilesIn(migrationDataIn(repo));
  const onDisk = schemaMigrationFiles(
    asAppPath(resolve(REPO_ROOT, MIGRATIONS_DATA_DIR)),
  );
  expect(viaSet.size).toBeGreaterThan(50);
  expect([...viaSet].sort()).toEqual([...onDisk].sort());
});
