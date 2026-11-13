import { test, expect } from "bun:test";
import { askSchemaFiles } from "@plugins/database/plugins/migrations/plugins/schema-question/core";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { DeclaredAnswer } from "./internal/declared.question";

const FIXTURE =
  "plugins/database/plugins/derived-updated-at/check/internal/fixtures/tables.ts";

test("names exactly the undeclared updated_at table of a schema file", async () => {
  const repo = await loadRepoFiles(asAppPath(await getWorktreeRoot()));
  const probe = await askSchemaFiles<DeclaredAnswer>(repo, {
    name: "derived-updated-at:declared",
    module: new URL("./internal/declared.question.ts", import.meta.url).href,
    files: [FIXTURE],
  });
  if (probe.kind !== "ok") throw new Error(probe.message);
  expect(probe.answers.get(FIXTURE)).toEqual({
    kind: "loaded",
    answer: ["dua_fixture_undeclared"],
  });
});
