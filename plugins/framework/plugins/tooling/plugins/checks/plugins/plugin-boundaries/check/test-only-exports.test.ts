import { describe, expect, it } from "bun:test";
import {
  barrelExportNames,
  collectBarrelUses,
  combineBarrelUses,
  findTestOnlyExports,
  summarizeBarrelUses,
} from "./test-only-exports";

const JOBS = "plugins/infra/plugins/jobs/server/index.ts";
const JOBS_SRC = [
  'import type { Def } from "@plugins/framework/plugins/server-core/core";',
  'export { defineJob, installQueueSchema as installSchema } from "./internal/define";',
  'export type { JobCtx } from "./internal/types";',
  "export type Handle = { id: string };",
  "export default { description: 'x' } satisfies Def;",
].join("\n");
const BARRELS = new Map([[JOBS, barrelExportNames(JOBS_SRC)]]);
const BARREL_SET = new Set(BARRELS.keys());

/** R13 messages for a repo made of JOBS plus these importer files. */
function r13(files: Record<string, string>): string[] {
  const uses = Object.entries(files).flatMap(([path, src]) =>
    collectBarrelUses(path, src, (p) => BARREL_SET.has(p)),
  );
  // One summary per importer, folded pairwise and whole: the same answer.
  const perFile = uses.map((u) => summarizeBarrelUses([u]));
  const whole = summarizeBarrelUses(uses);
  const paired = perFile.reduce(
    (acc, p) => combineBarrelUses([acc, p]),
    combineBarrelUses([]),
  );
  expect(paired).toEqual(whole);
  return findTestOnlyExports(BARRELS, whole).map((v) => v.message);
}

const TEST =
  "plugins/apps/plugins/mail/plugins/mail-core/server/internal/queue.test.ts";
const SHIPPING =
  "plugins/apps/plugins/mail/plugins/mail-core/server/internal/queue.ts";

describe("barrelExportNames", () => {
  it("lists the published names, skipping the default export", () => {
    expect(barrelExportNames(JOBS_SRC)).toEqual([
      "defineJob",
      "installSchema",
      "JobCtx",
      "Handle",
    ]);
  });
});

describe("findTestOnlyExports", () => {
  it("flags a named import used only by a test", () => {
    expect(
      r13({
        [TEST]:
          'import { defineJob } from "@plugins/infra/plugins/jobs/server";',
      }),
    ).toEqual([
      `\`defineJob\` is public, but only tests import it: \`${TEST}\``,
    ]);
  });

  it("passes a name shipping code also imports, and ignores names nobody imports", () => {
    expect(
      r13({
        [TEST]:
          'import { defineJob } from "@plugins/infra/plugins/jobs/server";',
        [SHIPPING]:
          'import { defineJob } from "@plugins/infra/plugins/jobs/server";',
      }),
    ).toEqual([]);
  });

  it("keys an aliased import on the barrel's name", () => {
    expect(
      r13({
        [TEST]:
          'import { installSchema as install, type JobCtx as Ctx } from "@plugins/infra/plugins/jobs/server";',
        [SHIPPING]:
          'import type { JobCtx } from "@plugins/infra/plugins/jobs/server";',
      }),
    ).toEqual([
      `\`installSchema\` is public, but only tests import it: \`${TEST}\``,
    ]);
  });

  it("does not count a type-only namespace import in a test as a use", () => {
    expect(
      r13({
        [TEST]:
          'import type * as Jobs from "@plugins/infra/plugins/jobs/server";',
      }),
    ).toEqual([]);
  });

  it("counts a value namespace import in shipping code as a use of every name", () => {
    expect(
      r13({
        [TEST]:
          'import { defineJob, type Handle } from "@plugins/infra/plugins/jobs/server";',
        [SHIPPING]:
          'import * as Jobs from "@plugins/infra/plugins/jobs/server";',
      }),
    ).toEqual([]);
  });

  it("resolves a test's relative import of its own plugin's barrel", () => {
    expect(
      r13({
        "plugins/infra/plugins/jobs/server/__tests__/define.test.ts":
          'import { defineJob } from "../index";',
        "plugins/infra/plugins/jobs/server/internal/run.test.ts":
          'import { type Handle } from "..";',
      }),
    ).toEqual([
      "`defineJob` is public, but only tests import it: `plugins/infra/plugins/jobs/server/__tests__/define.test.ts`",
      "`Handle` is public, but only tests import it: `plugins/infra/plugins/jobs/server/internal/run.test.ts`",
    ]);
  });

  it("counts `export … from` as a use", () => {
    expect(
      r13({
        [TEST]:
          'import { defineJob } from "@plugins/infra/plugins/jobs/server";',
        "plugins/apps/plugins/mail/plugins/mail-core/server/index.ts":
          'export { defineJob } from "@plugins/infra/plugins/jobs/server";',
      }),
    ).toEqual([]);
  });

  it("treats a testing/ importer as test code, and check/ as shipping", () => {
    expect(
      r13({
        "plugins/apps/plugins/mail/plugins/mail-core/server/testing/queue.ts":
          'import { defineJob } from "@plugins/infra/plugins/jobs/server";',
        "plugins/apps/plugins/mail/plugins/mail-core/check/index.ts":
          'import type { JobCtx } from "@plugins/infra/plugins/jobs/server";',
        [TEST]:
          'import type { JobCtx } from "@plugins/infra/plugins/jobs/server";',
      }),
    ).toEqual([
      "`defineJob` is public, but only tests import it: `plugins/apps/plugins/mail/plugins/mail-core/server/testing/queue.ts`",
    ]);
  });

  it("does not resolve a testing barrel as the public one", () => {
    expect(
      r13({
        [TEST]:
          'import { defineJob } from "@plugins/infra/plugins/jobs/server/testing";',
      }),
    ).toEqual([]);
  });

  it("names at most three test importers", () => {
    const files = Object.fromEntries(
      [1, 2, 3, 4, 5].map((i) => [
        `plugins/apps/plugins/mail/plugins/mail-core/server/q${i}.test.ts`,
        'import { defineJob } from "@plugins/infra/plugins/jobs/server";',
      ]),
    );
    expect(r13(files)).toEqual([
      "`defineJob` is public, but only tests import it: `plugins/apps/plugins/mail/plugins/mail-core/server/q1.test.ts`, `plugins/apps/plugins/mail/plugins/mail-core/server/q2.test.ts`, `plugins/apps/plugins/mail/plugins/mail-core/server/q3.test.ts` and 2 more",
    ]);
  });
});
