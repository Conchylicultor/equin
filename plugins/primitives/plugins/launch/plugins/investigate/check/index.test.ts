import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  createSourceAnalysis,
  readRepoCompilerOptions,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import {
  DECLARE_TARGETS,
  REGISTER_TARGET,
  unregisteredFailures,
} from "./analyze";

// Fixture repo: the real paths of the two targets (stubbed), made-up modules
// under `fx/` (`@fx/*`), read through the same analysis the check uses.
const BASE: Record<string, string> = {
  "tsconfig.json": `{ "compilerOptions": { "module": "ESNext", "moduleResolution": "bundler", "allowImportingTsExtensions": true, "noEmit": true, "paths": { "@plugins/*": ["./plugins/*"], "@fx/*": ["./fx/*"] } } }`,
  [DECLARE_TARGETS.collection.rel]:
    "export function liveCollection(key, spec) { return spec; }\nexport function liveArm(union, arm, spec) { return spec; }\n",
  [REGISTER_TARGET.rel]: "export const Investigate = { Register: (r) => r };\n",
};

const NPM =
  'import { enumTextField, intField, z, OUTCOMES, S } from "npm-fields"; ';
const LIVE = `${NPM}import { liveCollection, liveArm } from "@plugins/network/plugins/live/core";\n`;
const INV = `import { Investigate } from "@plugins/primitives/plugins/launch/plugins/investigate/web";\n`;

const META =
  'export const OUTCOME_META = {\n  ok: { label: "Ok", variant: "success" },\n  failed: { label: "Failed", variant: "destructive" },\n};\n';
const FIELDS =
  NPM +
  'import { OUTCOME_META } from "./meta";\nexport const runFields = {\n  outcome: enumTextField(OUTCOMES, { label: "Outcome", options: OUTCOME_META }),\n};\n';
const COLLECTION = `${LIVE}import { runFields } from "./fields";\nexport const runsList = liveCollection("a.runs", {\n  fields: runFields,\n  id: "id",\n  default: { limit: 100 },\n});\n`;
const A_CORE = {
  "fx/a/core/meta.ts": META,
  "fx/a/core/fields.ts": FIELDS,
  "fx/a/core/index.ts": COLLECTION,
};

async function run(files: Record<string, string>) {
  const all = { ...BASE, ...files };
  const repo = {
    has: (rel: string) => Object.hasOwn(all, rel),
    read: (rel: string) => Promise.resolve(all[rel] ?? null),
  };
  const analysis = createSourceAnalysis({
    ts,
    files: repo,
    parse: ({ rel, src }) =>
      Promise.resolve(
        ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true),
      ),
    compilerOptions: await readRepoCompilerOptions(ts, repo),
  });
  const r = await unregisteredFailures(ts, analysis, (grepArg) => {
    const re = new RegExp(grepArg);
    return Promise.resolve(
      Object.entries(all)
        .filter(([rel, src]) => /\.tsx?$/.test(rel) && re.test(src))
        .map(([rel, src]) => ({ rel, src })),
    );
  });
  return {
    missing: r.missing.map((m) => m.name),
    bearing: r.bearing.map((b) => b.name),
    unreadable: r.unreadable.map((u) => `${u.site.rel}:${u.site.line}`),
  };
}

describe("investigate:failures-registered", () => {
  test("a tint reached through a chain of imported constants is flagged until registered", async () => {
    expect((await run(A_CORE)).missing).toEqual(["runsList"]);
    const registered = await run({
      ...A_CORE,
      "fx/a/web/index.ts": `${INV}import { runsList } from "../core";\nexport const c = Investigate.Register({ owner: runsList, failed: () => true });\n`,
    });
    expect(registered).toEqual({
      missing: [],
      bearing: ["runsList"],
      unreadable: [],
    });
  });

  test("a helper passing `owner` on as its parameter registers what its callers pass", async () => {
    const r = await run({
      ...A_CORE,
      "fx/b/web/helper.ts": `${INV}export function investigateIt(owner, opts) {\n  return Investigate.Register({ owner, failed: () => true });\n}\n`,
      "fx/a/web/index.ts": `import { investigateIt as inv } from "@fx/b/web/helper";\nimport { runsList as rl } from "../core";\nconst c = inv(rl, { noun: "run" });\n`,
    });
    expect(r).toEqual({ missing: [], bearing: ["runsList"], unreadable: [] });
  });

  test("the spellings the regexes missed: a tint constant, a spread, a namespace re-export, an aliased factory", async () => {
    const r = await run({
      "fx/a/core/tints.ts":
        'export const DESTRUCTIVE = "destructive";\nexport const FAILED = { label: "Failed", variant: DESTRUCTIVE };\n',
      "fx/a/core/barrel.ts": 'export * as tints from "./tints";\n',
      "fx/a/core/index.ts": `${LIVE}import { tints } from "./barrel";\nimport * as T from "./tints";\nconst BASE = { failed: tints.FAILED };\nexport const viaSpread = liveCollection("a.x", {\n  fields: { s: enumTextField(S, { options: { ...BASE } }) },\n  default: { limit: 10 },\n});\nexport const viaNs = liveCollection("a.y", {\n  fields: { s: enumTextField(S, { options: { bad: { variant: T.DESTRUCTIVE } } }) },\n  all: { orderBy: [] },\n});\n`,
      "fx/b/core/live.ts":
        'export { liveCollection as declare } from "@plugins/network/plugins/live/core";\n',
      "fx/b/core/index.ts":
        NPM +
        'import { declare } from "./live";\nimport { FAILED } from "@fx/a/core/tints";\nexport const aliased = declare("b.z", { fields: { s: enumTextField(S, { options: { f: FAILED } }) }, default: { limit: 1 } });\n',
    });
    expect(r.missing.sort()).toEqual(["aliased", "viaNs", "viaSpread"]);
    expect(r.unreadable).toEqual([]);
  });

  test("untinted, lookup-only, a same-named local and a field named `variant` are not flagged", async () => {
    const r = await run({
      ...A_CORE,
      "fx/a/core/index.ts": `${LIVE}export const quiet = liveCollection("a.quiet", {\n  fields: { s: enumTextField(S, { options: { x: { label: "X", variant: "muted" } } }), variant: z.string() },\n  default: { limit: 10 },\n});\nexport const byId = liveCollection("a.by-id", {\n  fields: { s: enumTextField(S, { options: { failed: { variant: "destructive" } } }) },\n  id: "id",\n});\n`,
      // `runFields` here is ITS OWN local constant, not the tinted export.
      "fx/b/core/index.ts": `${LIVE}const runFields = { n: intField() };\nexport const other = liveCollection("b.other", { fields: runFields, default: { limit: 10 } });\n`,
    });
    expect(r).toEqual({ missing: [], bearing: [], unreadable: [] });
  });

  test("a tinted union is answered by its arms: the union is never flagged, every arm is", async () => {
    const files = {
      ...A_CORE,
      "fx/a/core/index.ts": `${LIVE}import { runFields } from "./fields";\nexport const all = liveCollection("a.all", {\n  fields: runFields,\n  arms: { discriminator: "kind" },\n  default: { limit: 10 },\n});\n`,
      "fx/b/core/index.ts": `${LIVE}import { all } from "@fx/a/core";\nexport const bArm = liveArm(all, "b", { label: "B", fields: {} });\n`,
    };
    expect((await run(files)).missing).toEqual(["bArm"]);
    const r = await run({
      ...files,
      "fx/b/web/index.ts": `${INV}import { bArm } from "../core";\nconst c = Investigate.Register({ owner: bArm });\n`,
    });
    expect(r.missing).toEqual([]);
  });

  test("fail-closed: an unreadable variant or owner is reported, unless the verdict is already known", async () => {
    const decl = `${LIVE}let V = "muted";\nexport const odd = liveCollection("a.odd", {\n  fields: { s: enumTextField(S, { options: { x: { variant: V } } }) },\n  default: { limit: 10 },\n});\n`;
    expect(await run({ "fx/a/core/index.ts": decl })).toEqual({
      missing: [],
      bearing: [],
      unreadable: ["fx/a/core/index.ts:2"],
    });
    // Registered: whatever the tint is, nothing is missing.
    const registered = await run({
      "fx/a/core/index.ts": decl,
      "fx/a/web/index.ts": `${INV}import { odd } from "../core";\nInvestigate.Register({ owner: odd });\n`,
    });
    expect(registered.unreadable).toEqual([]);
    // An owner that names no declaration could register anything.
    const r = await run({
      ...A_CORE,
      "fx/a/web/index.ts": `${INV}import { pick } from "npm-pick";\nInvestigate.Register({ owner: pick() });\n`,
    });
    expect(r.unreadable).toEqual(["fx/a/web/index.ts:3"]);
  });

  test("test files neither declare nor register", async () => {
    const r = await run({
      "fx/a/core/meta.ts": META,
      "fx/a/core/fields.ts": FIELDS,
      "fx/a/core/index.test.ts": COLLECTION,
    });
    expect(r).toEqual({ missing: [], bearing: [], unreadable: [] });
  });
});
