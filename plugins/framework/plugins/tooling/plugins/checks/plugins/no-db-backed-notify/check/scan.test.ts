import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import {
  createSourceAnalysis,
  readRepoCompilerOptions,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import {
  DB_TARGET,
  EXCLUSION_TARGET,
  NOTIFY_TARGETS,
  READER_TARGETS,
  findFeedExclusions,
  scanDbBackedNotify,
  type FeedExcludedTables,
} from "./scan";

// Fixture repo: the real paths of every target (stubbed, in the spellings the
// real barrels use — `defineExternalResource` is destructured off a runtime),
// and plugin sources read through the same analysis the check uses.
const STUBS: Record<string, string> = {
  "tsconfig.json": `{ "compilerOptions": { "module": "ESNext", "moduleResolution": "bundler", "allowImportingTsExtensions": true, "noEmit": true, "paths": { "@plugins/*": ["./plugins/*"] } } }`,
  [NOTIFY_TARGETS["defineExternalResource@server"].rel]:
    "export const { defineExternalResource, defineResource } = runtime;\n",
  [NOTIFY_TARGETS["defineExternalResource@central"].rel]:
    "export const { defineExternalResource } = runtime;\n",
  [NOTIFY_TARGETS["serveValue@server"].rel]:
    'export { serveValue } from "./internal/serve-value";\nexport { serveCollection } from "./internal/serve-collection";\n',
  "plugins/network/plugins/live/server/internal/serve-value.ts":
    "export const serveValue = (value, opts) => value;\n",
  "plugins/network/plugins/live/server/internal/serve-collection.ts":
    "export const serveCollection = (c, opts) => c;\n",
  [NOTIFY_TARGETS["serveValue@machine"].rel]:
    "export const serveValue = (value, opts) => value;\nexport const serveCollection = (c, opts) => c;\n",
  [NOTIFY_TARGETS["serveValue@central"].rel]:
    "export function serveValue(value, opts) { return value; }\n",
  [DB_TARGET.rel]: "export const db = connect();\n",
  [READER_TARGETS.executeRows.rel]:
    "export async function executeRows(db, q) { return db.execute(q); }\nexport async function queryRows(db, q) { return db.query(q); }\n",
  [EXCLUSION_TARGET.rel]: "export const ExcludeFromChangeFeed = (x) => x;\n",
};

const LIVE =
  'import { serveValue, serveCollection } from "@plugins/network/plugins/live/server";\n';
const DB = 'import { db } from "@plugins/database/server";\n';
const ROWS =
  'import { executeRows, queryRows } from "@plugins/database/plugins/sql-rows/core";\n';
const OLD =
  'import { defineExternalResource } from "@plugins/framework/plugins/server-core/core";\n';

// Real plugin paths (plugin-refs-resolve checks every path literal).
const SENTINEL =
  "plugins/debug/plugins/sentinel/server/internal/status-resource.ts";
const STATS = "plugins/stats/plugins/cost";
/** A sibling module of SENTINEL. */
const LOCAL = (name: string) =>
  `plugins/debug/plugins/sentinel/server/internal/${name}.ts`;
const LEDGER = "plugins/debug/plugins/latency-ledger";

/** Reads repo files by repo-relative path. */
interface Files {
  has(rel: string): boolean;
  read(rel: string): Promise<string | null>;
}

function analysisOver(files: Files) {
  return readRepoCompilerOptions(ts, files).then((compilerOptions) =>
    createSourceAnalysis({
      ts,
      files,
      parse: ({ rel, src }) =>
        Promise.resolve(
          ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true),
        ),
      compilerOptions,
    }),
  );
}

async function fixture(files: Record<string, string>) {
  const all = { ...STUBS, ...files };
  const analysis = await analysisOver({
    has: (rel) => Object.hasOwn(all, rel),
    read: (rel) => Promise.resolve(all[rel] ?? null),
  });
  const candidatesFor = (grepArg: string) => {
    const re = new RegExp(grepArg);
    return Promise.resolve(
      Object.entries(all)
        .filter(([rel, src]) => /\.tsx?$/.test(rel) && re.test(src))
        .map(([rel, src]) => ({ rel, src })),
    );
  };
  return { analysis, candidatesFor };
}

const OPTS = {
  skips: (rel: string) => /\.test\.ts$/.test(rel),
  slice: () => Promise.resolve(),
};

/** Scan the fixture: offenders, plus each unreadable spot as `rel:line`. */
async function scan(
  files: Record<string, string>,
  exclusions?: Map<string, FeedExcludedTables>,
) {
  const { analysis, candidatesFor } = await fixture(files);
  const found = await scanDbBackedNotify(
    ts,
    analysis,
    candidatesFor,
    exclusions ?? (await findFeedExclusions(ts, analysis, candidatesFor)),
    OPTS,
  );
  return {
    offenders: found.offenders,
    unreadable: found.unreadable.map((u) => `${u.site.rel}:${u.site.line}`),
  };
}

/** Just where the offenders are, `rel:line`. */
const at = async (files: Record<string, string>) =>
  (await scan(files)).offenders.map((o) => `${o.path}:${o.line}`);

const external = (loader: string, extra = "") =>
  [
    "export const served = serveValue(things, {",
    '  source: "external",',
    extra,
    `  loader: ${loader},`,
    "});",
  ]
    .filter((l) => l !== "")
    .join("\n");

describe("scanDbBackedNotify — defineExternalResource", () => {
  test("flags a call whose loader reads db, through the destructured export", async () => {
    expect(
      (
        await scan({
          [SENTINEL]: `${OLD}${DB}export const res = defineExternalResource({\n  key: "k",\n  loader: async () => db.select().from(_t),\n});\n`,
        })
      ).offenders,
    ).toEqual([{ path: SENTINEL, line: 3, marker: "defineExternalResource" }]);
  });

  test("passes a loader with no db read; db in a comment or string, or outside the call, never counts", async () => {
    expect(
      await at({
        [SENTINEL]: `${OLD}${DB}const rows = await db.select().from(_t);\nexport const res = defineExternalResource({\n  key: "k",\n  // db.select() here is only a comment\n  loader: () => readGitState("db.select"),\n});\n`,
      }),
    ).toEqual([]);
  });

  test("a name spelled `db` that is not the handle reads nothing", async () => {
    expect(
      await at({
        [SENTINEL]: `${LIVE}const db = { select: () => [] };\n${external("async () => db.select()")}\n`,
      }),
    ).toEqual([]);
  });
});

describe("scanDbBackedNotify — serveValue / serveCollection options", () => {
  test("flags an external value whose loader reads; passes the db arm and a declared read", async () => {
    expect(
      (
        await scan({
          [SENTINEL]: `${LIVE}${DB}${external("async () => db.select().from(_things)")}\n`,
        })
      ).offenders,
    ).toEqual([{ path: SENTINEL, line: 3, marker: "serveValue" }]);
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}export const s = serveValue(things, {\n  source: "db",\n  loader: async () => db.select().from(_things),\n});\n`,
      }),
    ).toEqual([]);
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}${external("async () => db.select().from(_things)", '  reads: () => ({ tables: tablesOf(), reason: "r" }),')}\n`,
      }),
    ).toEqual([]);
  });

  test("a `reads` key declares reads only when its value is seen to be one (fail-closed)", async () => {
    const LOADER = "async () => db.select().from(_things)";
    for (const reads of [
      "reads: undefined,",
      "reads: null,",
      "reads: void 0,",
      'reads: flag ? { tables: [], reason: "r" } : undefined,',
    ])
      expect(
        await at({
          [SENTINEL]: `${LIVE}${DB}${external(LOADER, `  ${reads}`)}\n`,
        }),
      ).toEqual([`${SENTINEL}:3`]);
    // A spread's reads is overridden by a later own `reads: undefined`.
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}const base = { reads: { tables: [], reason: "r" } };\n${external(LOADER, "  ...base,\n  reads: undefined,")}\n`,
      }),
    ).toEqual([`${SENTINEL}:4`]);
    // Declared through a const.
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}const READS = { tables: [], reason: "r" };\n${external(LOADER, "  reads: READS,")}\n`,
      }),
    ).toEqual([]);
    // A ternary whose arms both declare, and a const read for both `reads` and a spread.
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}const READS = { tables: [], reason: "r" };\nconst base = { reads: READS };\n${external(LOADER, "  ...base,\n  reads: flag ? READS : () => READS,")}\n`,
      }),
    ).toEqual([]);
    // A `reads` that cannot be read is a violation, not a declaration.
    const unreadable = await scan({
      [SENTINEL]: `${LIVE}${DB}${external(LOADER, "  reads: someObject.reads,")}\n`,
    });
    expect(unreadable.unreadable.length).toBe(1);
  });

  test("flags a db read in any external option, an external collection's answers included", async () => {
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}${external("() => readState()", "  revalidate: async () => (await db.execute(sql`SELECT 1`)).rows[0],")}\nexport const c = serveCollection(things, {\n  source: "external",\n  window: (q) => db.select().from(_things).limit(q.limit),\n});\nexport const t = serveCollection(things, {\n  from: _things,\n  where: eq(db.things.done, false),\n});\n`,
      }),
    ).toEqual([`${SENTINEL}:3`, `${SENTINEL}:8`]);
  });

  test("only the options' OWN source and reads count — never a key inside the loader", async () => {
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}${external("async () => {\n    const meta = { reads: [] };\n    return { meta, rows: await db.select().from(_things) };\n  }")}\n`,
      }),
    ).toEqual([`${SENTINEL}:3`]);
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}export const s = serveValue(things, {\n  source: "db",\n  loader: async () => {\n    const meta = { source: "external" };\n    return { meta, rows: await db.select().from(_things) };\n  },\n});\n`,
      }),
    ).toEqual([]);
  });

  test("options read through a const, a shorthand source, a spread and a helper's single return", async () => {
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}const source = "external";\nconst base = { source };\nconst opts = { ...base, loader: () => db.select().from(_t) };\nexport const a = serveValue(things, opts);\nfunction optionsFor() {\n  return { source: "external" as const, loader: () => db.select().from(_t) };\n}\nexport const b = serveValue(things, optionsFor());\n`,
      }),
    ).toEqual([`${SENTINEL}:6`, `${SENTINEL}:10`]);
  });

  test("options the check cannot read fail closed", async () => {
    const r = await scan({
      [SENTINEL]: `${LIVE}let opts = pick();\nexport const a = serveValue(things, opts);\nexport const b = serveValue(things, { source: kind(), loader });\nexport const c = serveValue.call(null, things, {});\n`,
    });
    expect(r.offenders).toEqual([]);
    expect(r.unreadable.sort()).toEqual(
      // the `let` itself, the computed source, the member call
      [`${SENTINEL}:2`, `${SENTINEL}:4`, `${SENTINEL}:5`].sort(),
    );
  });
});

describe("scanDbBackedNotify — what used to escape the regex scan", () => {
  test("the serve function through an `export *` barrel and an alias", async () => {
    expect(
      await at({
        [LOCAL("live")]:
          'export * from "@plugins/network/plugins/live/server";\n',
        [SENTINEL]: `import { serveValue as serve } from "./live";\n${DB}export const s = serve(things, {\n  source: "external",\n  loader: () => db.select().from(_t),\n});\n`,
      }),
    ).toEqual([`${SENTINEL}:3`]);
  });

  test("a namespace import of the serve barrel", async () => {
    expect(
      await at({
        [SENTINEL]: `import * as live from "@plugins/network/plugins/live/server";\n${DB}export const s = live.serveValue(things, {\n  source: "external",\n  loader: () => db.select().from(_t),\n});\n`,
      }),
    ).toEqual([`${SENTINEL}:3`]);
  });

  test("a loader chosen by a ternary, and one passed as a shorthand property", async () => {
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}function readDb() { return db.select().from(_t); }\nconst pick = flag ? readDb : readGit;\nexport const a = serveValue(things, { source: "external", loader: () => pick() });\nexport const b = serveValue(things, { source: "external", loader: () => go({ readDb }) });\n`,
      }),
    ).toEqual([`${SENTINEL}:5`, `${SENTINEL}:6`]);
  });

  test("the db handle aliased on import, or reached through a namespace", async () => {
    expect(
      await at({
        [SENTINEL]: `${LIVE}import { db as conn } from "@plugins/database/server";\nimport * as database from "@plugins/database/server";\nexport const a = serveValue(x, { source: "external", loader: () => conn.select() });\nexport const b = serveValue(y, { source: "external", loader: () => database.db.select() });\n`,
      }),
    ).toEqual([`${SENTINEL}:4`, `${SENTINEL}:5`]);
  });

  test("a wrapper forwarding to serveValue: each caller's argument is followed", async () => {
    const wrapper = `${LIVE}export function serveDerived(value, derive) {\n  return serveValue(value, {\n    source: "external",\n    loader: async () => derive(await readEvents()),\n  });\n}\n`;
    const r = await scan({
      [LOCAL("wrapper")]: wrapper,
      [SENTINEL]: `${DB}import { serveDerived } from "./wrapper";\nexport const a = serveDerived(x, (events) => events.length);\nexport const b = serveDerived(y, async () => db.select().from(_t));\n`,
    });
    expect(r.unreadable).toEqual([]);
    expect(r.offenders).toEqual([
      {
        path: LOCAL("wrapper"),
        line: 3,
        marker: "serveValue",
        via: `derive ← ${SENTINEL}:4`,
      },
    ]);
  });

  test("a wrapper's parameter default is followed where a caller omits the argument", async () => {
    const r = await scan({
      [LOCAL("wrapper")]:
        `${LIVE}${DB}export function serveIt(value, load = () => db.select().from(_t)) {\n  return serveValue(value, { source: "external", loader: () => load() });\n}\n`,
      [SENTINEL]:
        'import { serveIt } from "./wrapper";\nexport const a = serveIt(x);\n',
    });
    expect(r.offenders.map((o) => o.path)).toEqual([LOCAL("wrapper")]);
  });

  test("a wrapper the check cannot follow (unexported, or passed on as a value) fails closed", async () => {
    const r = await scan({
      [SENTINEL]: `${LIVE}function serveDerived(value, derive) {\n  return serveValue(value, { source: "external", loader: () => derive() });\n}\nexport const a = serveDerived(x, () => 1);\n`,
    });
    expect(r.unreadable).toEqual([`${SENTINEL}:2`]);
  });
});

describe("scanDbBackedNotify — reads and writes", () => {
  test("sql-rows readers read, unless their statement is DML", async () => {
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}${ROWS}export const a = serveValue(x, { source: "external", loader: () => executeRows(db, sql\`SELECT 1\`) });\nexport const b = serveValue(y, { source: "external", loader: () => queryRows( db, Row) });\nexport const c = serveValue(z, { source: "external", loader: () => executeRows(db, { query: sql\`UPDATE seen SET n = n + 1\` }) });\n`,
      }),
    ).toEqual([`${SENTINEL}:4`, `${SENTINEL}:5`]);
  });

  test("an execute whose statement is chosen by a ternary reads unless every branch is DML", async () => {
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}export const a = serveValue(x, { source: "external", loader: () => db.execute(c ? sql\`INSERT INTO t VALUES (1)\` : sql\`SELECT 1\`) });\nexport const b = serveValue(y, { source: "external", loader: () => db.execute(c ? sql\`INSERT INTO t VALUES (1)\` : sql\`DELETE FROM t WHERE \${sql\`id = 1\`}\`) });\n`,
      }),
    ).toEqual([`${SENTINEL}:3`]);
  });

  test("an imported loader that only writes is allowed; an execute that is not DML reads", async () => {
    const record = `${DB}${ROWS}export async function recordAndRead() {\n  await db.insert(_seen).values({ at: new Date() });\n  await db.update(_seen).set({ n: 1 });\n  await db.delete(_seen).where(lt(_seen.at, cutoff));\n  await db.execute(sql\`\n    INSERT INTO seen (at) VALUES (now())\`);\n  await executeRows(db, { query: sql\`UPDATE seen SET n = n + 1 RETURNING n\`, row: Row });\n  return readGitState();\n}\n`;
    expect(
      await at({
        [`${STATS}/server/internal/record.ts`]: record,
        [`${STATS}/server/internal/served.ts`]: `${LIVE}import { recordAndRead } from "./record";\n${external("() => recordAndRead()")}\n`,
      }),
    ).toEqual([]);
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}${external("async () => (await db.execute(sql`WITH x AS (SELECT 1) SELECT * FROM x`)).rows")}\n`,
      }),
    ).toEqual([`${SENTINEL}:3`]);
  });

  test("a handle bound to db under another name reads; one only written through does not", async () => {
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}function listChain(id, conn = db) {\n  return conn.select().from(_t);\n}\nfunction viaLocal() { const tx = db; return tx.query.things.findMany(); }\nfunction viaWrite(conn = db) { return conn.insert(_t).values({}); }\nfunction viaTx() { return db.transaction(async (tx) => tx.insert(_t)); }\nexport const a = serveValue(x, { source: "external", loader: ({ id }) => listChain(id) });\nexport const b = serveValue(y, { source: "external", loader: viaLocal });\nexport const c = serveValue(z, { source: "external", loader: viaWrite });\nexport const d = serveValue(w, { source: "external", loader: viaTx });\n`,
      }),
    ).toEqual([`${SENTINEL}:9`, `${SENTINEL}:10`, `${SENTINEL}:12`]);
  });

  test("follows an imported loader through a barrel, naming the chain", async () => {
    const r = await scan({
      [`${STATS}/server/index.ts`]:
        'export { readPushFiles } from "./internal/push-files";\n',
      [`${STATS}/server/internal/push-files.ts`]: `${DB}${ROWS}export const readPushFiles = async () =>\n  executeRows(db, { query: sql\`SELECT * FROM pushes\`, row: Row });\n`,
      [SENTINEL]: `${LIVE}import { readPushFiles as files } from "@plugins/stats/plugins/cost/server";\n${external("files")}\n`,
    });
    expect(r.offenders.map((o) => o.via)).toEqual([
      `files (${STATS}/server/internal/push-files.ts:3)`,
    ]);
  });

  test("follows references to any depth, and stops on a cycle", async () => {
    const chain = (n: number, read: boolean) =>
      [
        LIVE + DB,
        ...Array.from(
          { length: n },
          (_, i) => `function f${i}() { return f${i + 1}(); }`,
        ),
        read
          ? `function f${n}() { return db.select().from(_t); }`
          : `function f${n}() { return f0(); }`,
        external("() => f0()"),
      ].join("\n");
    expect(await at({ [SENTINEL]: chain(6, true) })).toHaveLength(1);
    expect(await at({ [SENTINEL]: chain(6, false) })).toEqual([]);
  });

  test("a same-file helper that reads but is not reached does not count; another served resource is not followed", async () => {
    expect(
      await at({
        [SENTINEL]: `${LIVE}${DB}function unrelated() { return db.select().from(_t); }\nconst readState = () => readGitState();\nexport const other = serveCollection(rows, { from: _t, where: eq(db.t.x, 1) });\n${external("readState", "  follows: (follow) => follow(other, () => ({ ids: [] })),")}\n`,
      }),
    ).toEqual([]);
  });

  test("a loader importing from a file of no repo fails closed; an npm package is followed no further", async () => {
    const r = await scan({
      [SENTINEL]: `${LIVE}import { load } from "some-package";\nimport { gone } from "./gone";\n${external("() => load(gone())")}\n`,
    });
    expect(r.offenders).toEqual([]);
    // the import naming no file
    expect([...new Set(r.unreadable)]).toEqual([`${SENTINEL}:3`]);
  });
});

describe("scanDbBackedNotify — derived feed-exclusion exemption", () => {
  const tables = {
    [`${LEDGER}/server/internal/tables.ts`]:
      'export const _ledgerMinute = pgTable(\n  "ledger_minute",\n  { minuteStart: bigint() },\n);\nexport const _ledgerState = pgTable("ledger_state", {});\n',
    [`${LEDGER}/server/internal/contributions.ts`]:
      'import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";\nimport { _ledgerMinute } from "./tables";\nexport const contributions = [\n  ExcludeFromChangeFeed({ table: _ledgerMinute, reason: "written every minute" }),\n];\n',
  };
  const served = (rel: string, table: string) => ({
    [rel]: `${LIVE}${DB}import { ${table} } from "${rel.startsWith(LEDGER) ? "./tables" : `../../latency-ledger/server/internal/tables`}";\n${external(`() => db.select().from(${table})`)}\n`,
  });

  test("findFeedExclusions collects the table's declaration and SQL name per plugin", async () => {
    const { analysis, candidatesFor } = await fixture(tables);
    const exclusions = await findFeedExclusions(ts, analysis, candidatesFor);
    expect([...exclusions.keys()]).toEqual([LEDGER]);
    expect([...exclusions.get(LEDGER)!.sqlNames]).toEqual(["ledger_minute"]);
    expect(exclusions.get(LEDGER)!.declarations.size).toBe(1);
  });

  test("a call over the plugin's excluded table is exempt; a sibling plugin, or another table, is not", async () => {
    expect(
      await at({
        ...tables,
        ...served(`${LEDGER}/server/internal/summary.ts`, "_ledgerMinute"),
      }),
    ).toEqual([]);
    expect(
      await at({
        ...tables,
        ...served(
          "plugins/debug/plugins/slow-ops/server/summary.ts",
          "_ledgerMinute",
        ),
      }),
    ).toHaveLength(1);
    expect(
      await at({
        ...tables,
        ...served(`${LEDGER}/server/internal/status.ts`, "_ledgerState"),
      }),
    ).toHaveLength(1);
  });

  test("a local named like the excluded table is not it", async () => {
    expect(
      await at({
        ...tables,
        [`${LEDGER}/server/internal/summary.ts`]: `${LIVE}${DB}const _ledgerMinute = 1;\n${external("() => db.select().from(_t).where(eq(_t.x, _ledgerMinute))")}\n`,
      }),
    ).toHaveLength(1);
  });

  test("an imported loader reading the excluded table by its SQL name is exempt", async () => {
    const query = (table: string) => ({
      [`${LEDGER}/server/internal/query.ts`]: `${DB}${ROWS}export async function loadSummary(window: string) {\n  return executeRows(db, { query: sql\`SELECT * FROM ${table} m\`, row: Row });\n}\n`,
      [`${LEDGER}/server/internal/summary.ts`]: `${LIVE}import { loadSummary } from "./query";\n${external("({ window }) => loadSummary(window)")}\n`,
    });
    expect(await at({ ...tables, ...query("ledger_minute") })).toEqual([]);
    expect(
      await at({ ...tables, ...query("ledger_minute_state") }),
    ).toHaveLength(1);
  });

  test("a table that is not a plain identifier, an exclusion in a string, or in test code, names nothing", async () => {
    const { analysis, candidatesFor } = await fixture({
      [`${LEDGER}/server/internal/a.ts`]:
        'import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";\ntables.flatMap((table) => [ExcludeFromChangeFeed({ table, reason: r })]);\nExcludeFromChangeFeed({ table: schema.minute, reason: r });\nconst s = "ExcludeFromChangeFeed({ table: _x })";\n',
      [`${LEDGER}/server/internal/a.test.ts`]:
        tables[`${LEDGER}/server/internal/contributions.ts`]!,
      [`${LEDGER}/server/internal/tables.ts`]:
        tables[`${LEDGER}/server/internal/tables.ts`]!,
    });
    expect((await findFeedExclusions(ts, analysis, candidatesFor)).size).toBe(
      0,
    );
  });

  // The ledger's real summary value: an external serveValue whose loader is
  // imported (./query) and reads the excluded tables through raw SQL, read on
  // the real files with the repo's own tsconfig.
  test("the latency ledger's real contributions exclude its four tables, and its summary value passes", async () => {
    const disk: Files = {
      has: () => true,
      read: (rel) =>
        readFile(resolve(REPO_ROOT, rel), "utf8").catch((err: unknown) => {
          if ((err as { code?: string }).code === "ENOENT") return null;
          throw err;
        }),
    };
    const analysis = await analysisOver({
      has: (rel) =>
        !rel.includes("node_modules") && existsSync(resolve(REPO_ROOT, rel)),
      read: disk.read,
    });
    const ledgerFiles = [
      `${LEDGER}/server/internal/contributions.ts`,
      `${LEDGER}/server/internal/summary-resource.ts`,
    ];
    const candidatesFor = async (grepArg: string) => {
      const re = new RegExp(grepArg);
      const out: { rel: string; src: string }[] = [];
      for (const rel of ledgerFiles) {
        const src = (await disk.read(rel))!;
        if (re.test(src)) out.push({ rel, src });
      }
      return out;
    };
    const exclusions = await findFeedExclusions(ts, analysis, candidatesFor);
    expect([...exclusions.get(LEDGER)!.sqlNames].sort()).toEqual([
      "latency_ledger_host_minute",
      "latency_ledger_interaction",
      "latency_ledger_minute",
      "latency_ledger_thread_minute",
    ]);
    const r = await scanDbBackedNotify(
      ts,
      analysis,
      candidatesFor,
      exclusions,
      OPTS,
    );
    expect(r.offenders).toEqual([]);
  });
});
