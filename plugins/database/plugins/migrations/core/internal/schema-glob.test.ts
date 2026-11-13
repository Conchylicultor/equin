import { expect, test } from "bun:test";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { schemaFilesIn, schemaGlobFiles } from "./schema-glob";

// The two enumerations of the schema files agree on this checkout: the disk
// walk drizzle-kit's globs make (`schemaGlobFiles`, which `probeSchema` loads)
// and the match over a file set every schema check reads (`schemaFilesIn`).
test("the file set's schema files are the ones drizzle-kit globs", async () => {
  const root = await getWorktreeRoot();
  const files = await loadRepoFiles(asAppPath(root));
  expect(schemaFilesIn(files)).toEqual(await schemaGlobFiles(root));
});
