import { describe, expect, test } from "bun:test";
import { scanJobReads } from "./job-reads.scan";

const FILE =
  "plugins/debug/plugins/worktree-cleanup/server/internal/reap-job.ts";
const head = `import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { ListA, ListB } from "@plugins/conversations/plugins/workspace/server";
import * as b from "@plugins/database/plugins/admin/server";
`;

describe("scanJobReads", () => {
  test("reads each read(List) of a destructured body, by its import", () => {
    const jobs = scanJobReads(
      `${head}export const j = defineSupervisedJob({
  name: "x.job",
  async run(_i, { log, read: r }) {
    const a = r(ListA);
    for (const x of [1]) r(b.ListC);
    log(String(a));
  },
});`,
      FILE,
    );
    expect(jobs).toEqual([
      {
        job: "x.job",
        reads: [
          {
            specifier: "@plugins/conversations/plugins/workspace/server",
            exported: "ListA",
            site: `${FILE}:7`,
          },
          {
            specifier: "@plugins/database/plugins/admin/server",
            exported: "ListC",
            site: `${FILE}:8`,
          },
        ],
      },
    ]);
  });

  test("reads ctx.read(List) of a context named whole, and a body with no reads", () => {
    expect(
      scanJobReads(
        `${head}defineSupervisedJob({ name: "x.a", run: async (_i, ctx) => { ctx.log("x"); ctx.read(ListB); } });
defineSupervisedJob({ name: "x.b", argv: () => ({ argv: [] }) });
defineSupervisedJob({ name: "x.c", async run() {} });`,
        FILE,
      ),
    ).toEqual([
      {
        job: "x.a",
        reads: [
          {
            specifier: "@plugins/conversations/plugins/workspace/server",
            exported: "ListB",
            site: `${FILE}:4`,
          },
        ],
      },
      { job: "x.c", reads: [] },
    ]);
  });

  test("refuses a read the scan cannot see", () => {
    const refused = (body: string) => () =>
      scanJobReads(
        `${head}defineSupervisedJob({ name: "x.j", ${body} });`,
        FILE,
      );
    expect(refused("async run(_i, { read }) { helper(read); }")).toThrow(
      /used other than called/,
    );
    expect(refused("async run(_i, ctx) { helper(ctx); }")).toThrow(
      /used as a value/,
    );
    expect(refused("async run(_i, { ...rest }) {}")).toThrow(
      /rest is collected/,
    );
    expect(
      refused("async run(_i, { read }) { const L = ListA; read(L); }"),
    ).toThrow(/not imported by name/);
    expect(refused("run: body")).toThrow(/not written inline/);
    expect(refused("async run(_i, { read }) { const read = 1; }")).toThrow(
      /declared again/,
    );
  });
});
