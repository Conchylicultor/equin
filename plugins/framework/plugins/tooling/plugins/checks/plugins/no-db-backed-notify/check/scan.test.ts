import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ModuleIndex } from "./resolve";
import {
  findFeedExclusions,
  pluginRootOf,
  scanDbBackedNotify,
  type FeedExcludedTables,
} from "./scan";

/** A ModuleIndex over in-memory files (repo-relative path → source). */
const memory = (files: Record<string, string> = {}) =>
  new ModuleIndex({
    has: (rel) => rel in files,
    read: async (rel) => files[rel] ?? null,
  });

const SENTINEL =
  "plugins/debug/plugins/sentinel/server/internal/status-resource.ts";

const scan = (
  src: string,
  rel = SENTINEL,
  files: Record<string, string> = {},
) => scanDbBackedNotify([{ rel, src }], new Map(), memory(files));

describe("scanDbBackedNotify — defineExternalResource", () => {
  test("flags a call whose loader reads db.", async () => {
    const src = [
      'import { db } from "@plugins/database/server";',
      "export const res = defineExternalResource({",
      '  key: "k",',
      '  mode: "push",',
      "  loader: async () => db.select().from(_t),",
      "});",
    ].join("\n");
    expect(await scan(src)).toEqual([
      {
        path: "plugins/debug/plugins/sentinel/server/internal/status-resource.ts",
        line: 2,
        marker: "defineExternalResource",
      },
    ]);
  });

  test("flags the generic form spanning lines", async () => {
    const src = [
      "export const res = defineExternalResource<",
      "  Payload,",
      "  { id: string }",
      ">({",
      '  key: "k",',
      "  loader: async ({ id }) => db.query.things.findFirst({ where: eq(t.id, id) }),",
      "});",
    ].join("\n");
    expect((await scan(src)).map((o) => o.line)).toEqual([1]);
  });

  test("passes a loader with no db. read, and ignores db. outside the call", async () => {
    const src = [
      "const rows = await db.select().from(_t);",
      "export const res = defineExternalResource({",
      '  key: "k",',
      "  // db.select() here is only a comment",
      '  loader: () => readGitState("db.select"),',
      "});",
    ].join("\n");
    expect(await scan(src)).toEqual([]);
  });
});

describe("scanDbBackedNotify — serveValue", () => {
  test("flags an external loader that reads db.", async () => {
    const src = [
      'import { serveValue } from "@plugins/network/plugins/live/server";',
      "",
      "export const served = serveValue(things, {",
      '  source: "external",',
      "  loader: async () => {",
      "    const rows = await db.select().from(_things);",
      "    return rows;",
      "  },",
      "});",
    ].join("\n");
    expect(await scan(src)).toEqual([
      {
        path: "plugins/debug/plugins/sentinel/server/internal/status-resource.ts",
        line: 3,
        marker: "serveValue",
      },
    ]);
  });

  test("flags a db. read in any external option, not only the loader", async () => {
    const src = [
      "export const served = serveValue(things, {",
      '  source: "external",',
      "  loader: () => readState(),",
      "  revalidate: async () => (await db.execute(sql`SELECT 1`)).rows[0],",
      "});",
    ].join("\n");
    expect((await scan(src)).map((o) => o.marker)).toEqual(["serveValue"]);
  });

  test("passes the db arm reading db.", async () => {
    const src = [
      "export const served = serveValue(things, {",
      '  source: "db",',
      "  loader: async () => db.select().from(_things),",
      "});",
    ].join("\n");
    expect(await scan(src)).toEqual([]);
  });

  test("passes an external loader that reads no db.", async () => {
    const src = [
      "export const served = serveValue(refHead, {",
      '  source: "external",',
      "  loader: async () => readRefHead(),",
      "});",
    ].join("\n");
    expect(await scan(src)).toEqual([]);
  });

  test("reads only the options object's own source, never one inside the loader", async () => {
    const src = [
      "export const served = serveValue(things, {",
      '  source: "db",',
      "  loader: async () => {",
      '    const meta = { source: "external" };',
      "    return { meta, rows: await db.select().from(_things) };",
      "  },",
      "});",
    ].join("\n");
    expect(await scan(src)).toEqual([]);
  });

  test("ignores serveValue's own declaration and a serveValue in a string", async () => {
    const src = [
      "export function serveValue<T, P extends Record<string, string>>(",
      "  value: LiveValue<T, P>,",
      "  opts: ServeValueOptions<T, P>,",
      "): ServedValue<T, P> {",
      "  return register(db.schema, value, opts);",
      "}",
      'const doc = "serveValue(v, { source: \\"external\\", loader: () => db.select() })";',
    ].join("\n");
    expect(await scan(src)).toEqual([]);
  });

  test("reports each spelling in a file that has both", async () => {
    const src = [
      "export const a = defineExternalResource({",
      '  key: "a",',
      "  loader: () => db.select().from(_a),",
      "});",
      "export const b = serveValue(bValue, {",
      '  source: "external",',
      "  loader: () => db.select().from(_b),",
      "});",
    ].join("\n");
    expect((await scan(src)).map((o) => [o.line, o.marker])).toEqual([
      [1, "defineExternalResource"],
      [5, "serveValue"],
    ]);
  });
});

describe("scanDbBackedNotify — sql-rows readers", () => {
  test("flags executeRows(db, …) / queryRows(db, …) in an external call", async () => {
    const src = [
      "export const served = serveValue(things, {",
      '  source: "external",',
      "  loader: () => executeRows(db, sql`SELECT 1`, Row),",
      "});",
      "export const other = serveValue(more, {",
      '  source: "external",',
      "  loader: () => queryRows( db, Row),",
      "});",
    ].join("\n");
    expect((await scan(src)).map((o) => o.line)).toEqual([1, 5]);
  });
});

describe("scanDbBackedNotify — loaders defined outside the call", () => {
  // Real plugin paths (plugin-refs-resolve checks every path literal).
  const stats = "plugins/stats/plugins/cost";
  const served = `${stats}/server/internal/cost-resource.ts`;

  test("flags an imported loader that reads, naming the chain", async () => {
    const src = [
      'import { serveValue } from "@plugins/network/plugins/live/server";',
      'import { loadBundle } from "./bundle";',
      "",
      "export const costServed = serveValue(cost, {",
      '  source: "external",',
      "  loader: ({ range }) => loadBundle(range),",
      "});",
    ].join("\n");
    const bundle = [
      'import { db } from "@plugins/database/server";',
      "",
      "export async function loadBundle(range: string): Promise<{ rows: Row[] }> {",
      "  return { rows: await db.select().from(_conversations) };",
      "}",
    ].join("\n");
    expect(
      await scan(src, served, {
        [`${stats}/server/internal/bundle.ts`]: bundle,
      }),
    ).toEqual([
      {
        path: served,
        line: 4,
        marker: "serveValue",
        via: `loadBundle (${stats}/server/internal/bundle.ts:3)`,
      },
    ]);
  });

  test("follows an @plugins barrel and its re-export to the loader", async () => {
    const src = [
      'import { readPushFiles as files } from "@plugins/stats/plugins/cost/server";',
      "export const served = serveValue(pushFiles, {",
      '  source: "external",',
      "  loader: files,",
      "});",
    ].join("\n");
    const loaderBody = [
      "export const readPushFiles = async () =>",
      "  executeRows(db, { query: sql`SELECT * FROM pushes`, row: Row });",
    ].join("\n");
    const found = await scan(src, SENTINEL, {
      [`${stats}/server/index.ts`]:
        'export { readPushFiles } from "./internal/push-files";\n',
      [`${stats}/server/internal/push-files.ts`]: loaderBody,
    });
    expect(found.map((o) => o.via)).toEqual([
      `files (${stats}/server/internal/push-files.ts:1)`,
    ]);
  });

  test("allows an imported loader that only writes", async () => {
    const src = [
      'import { recordAndRead } from "./record";',
      "export const served = serveValue(state, {",
      '  source: "external",',
      "  loader: () => recordAndRead(),",
      "});",
    ].join("\n");
    const record = [
      "export async function recordAndRead() {",
      "  await db.insert(_seen).values({ at: new Date() });",
      "  await db.update(_seen).set({ n: 1 });",
      "  await db.delete(_seen).where(lt(_seen.at, cutoff));",
      "  await db.execute(sql`",
      "    INSERT INTO seen (at) VALUES (now()) ON CONFLICT DO NOTHING`);",
      "  await executeRows(db, { query: sql`UPDATE seen SET n = n + 1 RETURNING n`, row: Row });",
      "  return readGitState();",
      "}",
    ].join("\n");
    expect(
      await scan(src, served, {
        [`${stats}/server/internal/record.ts`]: record,
      }),
    ).toEqual([]);
  });

  test("an execute that is not DML still reads", async () => {
    const src = [
      "export const served = serveValue(state, {",
      '  source: "external",',
      "  loader: async () => (await db.execute(sql`WITH x AS (SELECT 1) SELECT * FROM x`)).rows,",
      "});",
    ].join("\n");
    expect(await scan(src)).toHaveLength(1);
  });

  test("flags a same-file named loader (function or const)", async () => {
    const src = [
      "async function loadThings(): Promise<Thing[]> {",
      "  return db.select().from(_things);",
      "}",
      "const loadOther = async () => {",
      "  const rows = await db.query.other.findMany();",
      "  return rows;",
      "};",
      "export const a = serveValue(things, {",
      '  source: "external",',
      "  loader: loadThings,",
      "});",
      "export const b = serveValue(other, {",
      '  source: "external",',
      "  loader: () => loadOther(),",
      "});",
    ].join("\n");
    expect((await scan(src)).map((o) => [o.line, o.via])).toEqual([
      [8, `loadThings (${SENTINEL}:1)`],
      [12, `loadOther (${SENTINEL}:4)`],
    ]);
  });

  test("a same-file helper that reads but is not reached does not count", async () => {
    const src = [
      "function unrelated() {",
      "  return db.select().from(_t);",
      "}",
      "const readState = () => readGitState();",
      "export const served = serveValue(state, {",
      '  source: "external",',
      "  loader: readState,",
      "});",
    ].join("\n");
    expect(await scan(src)).toEqual([]);
  });

  test("follows references to any depth, and stops on a cycle", async () => {
    const chain = (n: number, read: boolean) =>
      [
        ...Array.from(
          { length: n },
          (_, i) => `function f${i}() { return f${i + 1}(); }`,
        ),
        read
          ? `function f${n}() { return db.select().from(_t); }`
          : `function f${n}() { return f0(); }`,
        "export const served = serveValue(state, {",
        '  source: "external",',
        "  loader: () => f0(),",
        "});",
      ].join("\n");
    expect(await scan(chain(6, true))).toHaveLength(1);
    // f6 calls back into f0: the walk ends, nothing reads.
    expect(await scan(chain(6, false))).toEqual([]);
  });

  test("a handle bound to db under another name reads", async () => {
    const src = [
      "function listChain(id, conn: Db = db) {",
      "  return conn.select().from(_t);",
      "}",
      "function viaLocal() { const tx = db; return tx.query.things.findMany(); }",
      "function viaWrite(conn = db) { return conn.insert(_t).values({}); }",
      "export const a = serveValue(x, {",
      '  source: "external",',
      "  loader: ({ id }) => listChain(id),",
      "});",
      "export const b = serveValue(y, {",
      '  source: "external",',
      "  loader: viaLocal,",
      "});",
      "export const c = serveValue(z, {",
      '  source: "external",',
      "  loader: viaWrite,",
      "});",
    ].join("\n");
    expect((await scan(src)).map((o) => o.line)).toEqual([6, 10]);
  });

  test("follows the receiver of a method call to its const", async () => {
    const files = {
      "plugins/debug/plugins/sentinel/server/internal/memo.ts": [
        "export const sessionMemo = createSignedMemo({",
        "  load: (id) => db.select().from(_conversations),",
        "});",
      ].join("\n"),
    };
    const src = [
      'import { sessionMemo } from "./memo";',
      "export const served = serveValue(state, {",
      '  source: "external",',
      "  loader: ({ id }) => sessionMemo.get(id),",
      "});",
    ].join("\n");
    expect((await scan(src, SENTINEL, files)).map((o) => o.line)).toEqual([2]);
  });

  test("a loader from an npm package or a missing file resolves to nothing", async () => {
    const src = [
      'import { load } from "some-package";',
      'import { gone } from "./gone";',
      "export const served = serveValue(state, {",
      '  source: "external",',
      "  loader: () => load(gone()),",
      "});",
    ].join("\n");
    expect(await scan(src)).toEqual([]);
  });
});

describe("scanDbBackedNotify — derived feed-exclusion exemption", () => {
  const external = (table: string) =>
    [
      "export const served = serveValue(summary, {",
      '  source: "external",',
      `  loader: ({ window }) => db.select().from(${table}),`,
      "});",
    ].join("\n");
  const exclusion = [
    'import { ExcludeFromChangeFeed } from "@plugins/database/plugins/change-feed/server";',
    'import { _ledgerMinute } from "./tables";',
    "export const contributions = [",
    '  ExcludeFromChangeFeed({ table: _ledgerMinute, reason: "written every minute" }),',
    "];",
  ].join("\n");
  // Real plugin paths (plugin-refs-resolve checks every path literal): the
  // ledger, its parent and a sibling.
  const ledger = "plugins/debug/plugins/latency-ledger";
  const parent = "plugins/debug";
  const sibling = "plugins/debug/plugins/slow-ops";
  const tables = {
    [`${ledger}/server/internal/tables.ts`]: [
      "export const _ledgerMinute = pgTable(",
      '  "ledger_minute",',
      "  { minuteStart: bigint() },",
      ");",
    ].join("\n"),
  };
  const ledgerExclusions = () =>
    findFeedExclusions(
      [{ rel: `${ledger}/server/internal/contributions.ts`, src: exclusion }],
      memory(tables),
    );
  const at = async (
    rel: string,
    src: string,
    exclusions: Map<string, FeedExcludedTables>,
    files: Record<string, string> = {},
  ) => scanDbBackedNotify([{ rel, src }], exclusions, memory(files));

  test("pluginRootOf names the deepest plugin a file sits in", () => {
    expect(pluginRootOf(`${ledger}/server/internal/summary.ts`)).toBe(ledger);
    expect(pluginRootOf("plugins/tasks/server/index.ts")).toBe("plugins/tasks");
    expect(pluginRootOf("cli/index.ts")).toBeNull();
  });

  test("findFeedExclusions collects each call's table identifier and SQL name per plugin", async () => {
    expect([...(await ledgerExclusions())]).toEqual([
      [
        ledger,
        {
          identifiers: new Set(["_ledgerMinute"]),
          sqlNames: new Set(["ledger_minute"]),
        },
      ],
    ]);
  });

  test("a call over the plugin's excluded table is exempt; its sibling is not", async () => {
    const exclusions = await ledgerExclusions();
    const src = external("_ledgerMinute");
    expect(
      await at(`${ledger}/server/internal/summary.ts`, src, exclusions),
    ).toEqual([]);
    expect(
      await at(`${sibling}/server/summary.ts`, src, exclusions),
    ).toHaveLength(1);
    expect(
      await at(`${parent}/server/summary.ts`, src, exclusions),
    ).toHaveLength(1);
  });

  test("an imported loader reading the excluded table by its SQL name is exempt", async () => {
    const exclusions = await ledgerExclusions();
    const src = [
      'import { loadSummary } from "./query";',
      "export const served = serveValue(summary, {",
      '  source: "external",',
      "  loader: ({ window }) => loadSummary(window),",
      "});",
    ].join("\n");
    const query = (table: string) => ({
      [`${ledger}/server/internal/query.ts`]: [
        "export async function loadSummary(window: string) {",
        `  return executeRows(db, { query: sql\`SELECT * FROM ${table} m\`, row: Row });`,
        "}",
      ].join("\n"),
    });
    const rel = `${ledger}/server/internal/summary.ts`;
    expect(await at(rel, src, exclusions, query("ledger_minute"))).toEqual([]);
    expect(
      await at(rel, src, exclusions, query("ledger_minute_state")),
    ).toHaveLength(1);
  });

  test("the same plugin serving external over a feed-visible table is flagged", async () => {
    const exclusions = await ledgerExclusions();
    const rel = `${ledger}/server/internal/status.ts`;
    expect(await at(rel, external("_ledgerState"), exclusions)).toHaveLength(1);
    // A whole-word match only: a longer name sharing the prefix is not it.
    expect(
      await at(rel, external("_ledgerMinuteState"), exclusions),
    ).toHaveLength(1);
  });

  test("an exclusion exempts its own plugin only, never a child plugin", async () => {
    const exclusions = await findFeedExclusions(
      [{ rel: `${parent}/server/index.ts`, src: exclusion }],
      memory(),
    );
    expect([...exclusions.keys()]).toEqual([parent]);
    expect(
      await at(
        `${ledger}/server/internal/summary.ts`,
        external("_ledgerMinute"),
        exclusions,
      ),
    ).toHaveLength(1);
  });

  test("a table that is not a plain identifier names nothing", async () => {
    const exclusions = await findFeedExclusions(
      [
        {
          rel: `${ledger}/server/internal/contributions.ts`,
          src: [
            "tables.flatMap((table) => [ExcludeFromChangeFeed({ table, reason: r })]);",
            "ExcludeFromChangeFeed({ table: schema.minute, reason: r });",
            "ExcludeFromChangeFeed({ table: pick(), reason: r });",
          ].join("\n"),
        },
      ],
      memory(),
    );
    expect(exclusions.size).toBe(0);
  });

  test("an exclusion in a comment, a string or test code exempts nothing", async () => {
    const exclusions = await findFeedExclusions(
      [
        {
          rel: `${ledger}/server/internal/a.ts`,
          src: '// ExcludeFromChangeFeed({ table: _x })\nconst s = "ExcludeFromChangeFeed({ table: _x })";',
        },
        { rel: `${ledger}/server/internal/a.test.ts`, src: exclusion },
        { rel: `${ledger}/server/testing/index.ts`, src: exclusion },
      ],
      memory(),
    );
    expect(exclusions.size).toBe(0);
  });

  test("the exclusion's own definition (not a call) exempts nothing", async () => {
    const exclusions = await findFeedExclusions(
      [
        {
          rel: "plugins/database/plugins/change-feed/server/internal/exclusion.ts",
          src: 'export const ExcludeFromChangeFeed = defineServerContribution<{ table: PgTable }>("x");',
        },
      ],
      memory(),
    );
    expect(exclusions.size).toBe(0);
  });

  // The ledger's real summary value: an external serveValue whose loader is
  // imported (./query) and reads the excluded tables through raw SQL — the
  // whole path the exemption has to carry, on the real files.
  test("the latency ledger's real summary value passes", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../../../../../../..");
    const disk = new ModuleIndex({
      has: (r) => existsSync(resolve(repoRoot, r)),
      read: async (r) => readFileSync(resolve(repoRoot, r), "utf8"),
    });
    const read = (rel: string) => ({
      rel,
      src: readFileSync(resolve(repoRoot, rel), "utf8"),
    });
    const exclusions = await findFeedExclusions(
      [read(`${ledger}/server/internal/contributions.ts`)],
      disk,
    );
    expect(
      await scanDbBackedNotify(
        [read(`${ledger}/server/internal/summary-resource.ts`)],
        exclusions,
        disk,
      ),
    ).toEqual([]);
    // Without the exclusions, the same value is caught through its import.
    expect(
      await scanDbBackedNotify(
        [read(`${ledger}/server/internal/summary-resource.ts`)],
        new Map(),
        disk,
      ),
    ).toHaveLength(1);
  });

  // Pins the link the exemption was built for: the latency ledger's real
  // declarations name every one of its four tables (and resolve to their SQL
  // names, which its raw-SQL summary query uses), so its summary value may
  // read them while served external.
  test("the latency ledger's real contributions exclude its four tables", async () => {
    const repoRoot = resolve(import.meta.dir, "../../../../../../../../..");
    const rel = `${ledger}/server/internal/contributions.ts`;
    const disk = new ModuleIndex({
      has: (r) => existsSync(resolve(repoRoot, r)),
      read: async (r) => readFileSync(resolve(repoRoot, r), "utf8"),
    });
    const exclusions = await findFeedExclusions(
      [{ rel, src: readFileSync(resolve(repoRoot, rel), "utf8") }],
      disk,
    );
    expect(exclusions.get(ledger)).toEqual({
      identifiers: new Set([
        "_latencyLedgerMinute",
        "_latencyLedgerHostMinute",
        "_latencyLedgerThreadMinute",
        "_latencyLedgerInteraction",
      ]),
      sqlNames: new Set([
        "latency_ledger_minute",
        "latency_ledger_host_minute",
        "latency_ledger_thread_minute",
        "latency_ledger_interaction",
      ]),
    });
  });
});
