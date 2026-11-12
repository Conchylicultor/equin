import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  createSourceAnalysis,
  readRepoCompilerOptions,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import {
  LIVE_TARGETS,
  unregisteredArms,
  unregisteredExposures,
  unresolvedClientFields,
} from "./registrations";

// Fixture repo: the real paths of the targets (stubbed) and made-up plugins
// `a` and `b` (spelled through a template, so the plugin-refs scan does not
// read them as references to real plugins), read through the same analysis
// the checks use.
const P = (plugin: string, path: string) => `plugins/${plugin}/${path}`;

const BASE: Record<string, string> = {
  "tsconfig.json": `{ "compilerOptions": { "module": "ESNext", "moduleResolution": "bundler", "allowImportingTsExtensions": true, "noEmit": true, "paths": { "@plugins/*": ["./plugins/*"] } } }`,
  [LIVE_TARGETS.shape.rel]:
    "export function defineExtensionShape(spec) { return spec; }\n",
  [LIVE_TARGETS.extension.rel]:
    "export function defineExtension(parent, name, shape) { return shape; }\n",
  [LIVE_TARGETS.arm.rel]:
    "export function liveArm(union, arm, spec) { return spec; }\nexport function clientFields(owner, id, spec) { return spec; }\n",
  [LIVE_TARGETS.presentation.rel]:
    "export const FieldPresentation = { Register: (r) => r };\nexport const ClientFields = { Resolve: (r) => r };\n",
  [LIVE_TARGETS.columns.rel]:
    "export const LiveColumns = { Expose: (e) => e };\n",
};

const ENTITY_CORE = `import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";\n`;
const ENTITY_SERVER = `import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";\n`;
const LIVE_CORE = `import { liveArm, clientFields } from "@plugins/network/plugins/live/core";\n`;
const LIVE_WEB = `import { FieldPresentation, ClientFields } from "@plugins/network/plugins/live/web";\n`;
const LIVE_SERVER = `import { LiveColumns } from "@plugins/network/plugins/live/server";\n`;

async function fixture(files: Record<string, string>) {
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
  const ts_ = Object.entries(all).filter(([rel]) => /\.tsx?$/.test(rel));
  const candidatesFor = (grepArg: string) => {
    const re = new RegExp(grepArg);
    return Promise.resolve(
      ts_.filter(([, src]) => re.test(src)).map(([rel, src]) => ({ rel, src })),
    );
  };
  const filesUnder = (dirs: readonly string[]) =>
    Promise.resolve(
      ts_
        .filter(([rel]) => dirs.some((d) => rel.startsWith(`${d}/`)))
        .map(([rel, src]) => ({ rel, src })),
    );
  return { analysis, candidatesFor, filesUnder };
}

const summary = (r: {
  missing: string[];
  unreadable: { site: { rel: string; line: number } }[];
}) => ({
  missing: r.missing,
  unreadable: r.unreadable.map((u) => `${u.site.rel}:${u.site.line}`),
});

async function exposures(files: Record<string, string>) {
  const f = await fixture(files);
  return summary(await unregisteredExposures(ts, f.analysis, f.candidatesFor));
}
async function arms(files: Record<string, string>) {
  const f = await fixture(files);
  return summary(
    await unregisteredArms(ts, f.analysis, f.candidatesFor, f.filesUnder),
  );
}
async function clientFieldsOf(files: Record<string, string>) {
  const f = await fixture(files);
  return summary(await unresolvedClientFields(ts, f.analysis, f.candidatesFor));
}

describe("live:exposures-registered", () => {
  const SHAPE = `${ENTITY_CORE}export const trackShape = defineExtensionShape({\n  key: "taskId",\n  exposes: { parent, name: "track", fields: {} },\n});\n`;
  const TABLE = `${ENTITY_SERVER}import { trackShape } from "../../shared/shape";\nexport const tasksTrack = defineExtension(_tasks, "track", trackShape);\n`;
  const SERVER = `${LIVE_SERVER}import { tasksTrack as ext } from "./internal/tables";\nconst x = [LiveColumns.Expose(ext)];\n`;
  const WEB = `${LIVE_WEB}import { trackShape } from "../shared/shape";\nconst c = FieldPresentation.Register({\n  owner: trackShape.exposure,\n});\n`;
  const A = {
    [P("a", "shared/shape.ts")]: SHAPE,
    [P("a", "server/internal/tables.ts")]: TABLE,
    [P("a", "server/index.ts")]: SERVER,
    [P("a", "web/index.ts")]: WEB,
  };

  test("a shape folded by its server and registered by its web passes", async () => {
    expect(await exposures(A)).toEqual({ missing: [], unreadable: [] });
  });

  test("a missing half — or one in another plugin, or in test code — is named", async () => {
    const { [P("a", "web/index.ts")]: _web, ...noWeb } = A;
    expect((await exposures(noWeb)).missing).toEqual([
      "plugins/a/shared/shape.ts:2 — trackShape (web: FieldPresentation.Register)",
    ]);
    const { [P("a", "server/index.ts")]: _srv, ...noFold } = A;
    expect((await exposures(noFold)).missing).toEqual([
      "plugins/a/shared/shape.ts:2 — trackShape (server: LiveColumns.Expose)",
    ]);
    // Another plugin's halves register nothing for `a`.
    expect(
      (
        await exposures({
          [P("a", "shared/shape.ts")]: SHAPE,
          [P("b", "server/internal/tables.ts")]: TABLE.replace(
            "../../shared/shape",
            "../../../a/shared/shape",
          ),
          [P("b", "server/index.ts")]: SERVER,
          [P("b", "web/index.ts")]: WEB.replace(
            "../shared/shape",
            "../../a/shared/shape",
          ),
        })
      ).missing,
    ).toHaveLength(1);
    // Test code registers nothing.
    const { [P("a", "web/index.ts")]: web, ...rest } = A;
    expect(
      (await exposures({ ...rest, [P("a", "web/__tests__/x.test.ts")]: web! }))
        .missing,
    ).toHaveLength(1);
  });

  test("a registration names the shape by RESOLUTION, never by spelling", async () => {
    // A local `trackShape` that is not the shape registers nothing.
    expect(
      (
        await exposures({
          ...A,
          [P("a", "web/index.ts")]:
            `${LIVE_WEB}const trackShape = { exposure: 1 };\nconst c = FieldPresentation.Register({ owner: trackShape.exposure });\n`,
        })
      ).missing,
    ).toEqual([
      "plugins/a/shared/shape.ts:2 — trackShape (web: FieldPresentation.Register)",
    ]);
  });

  test("an aliased factory, a barrel `export *` and a ternary initializer are all read", async () => {
    expect(
      await exposures({
        ...A,
        // the factory reached through an `export *` barrel and an alias
        [P("a", "core/index.ts")]:
          `export * from "@plugins/infra/plugins/entity-extensions/core";\n`,
        [P("a", "shared/shape.ts")]:
          `import { defineExtensionShape as shape } from "../core";\nexport const trackShape = flag\n  ? shape({ exposes: { parent } })\n  : other;\n`,
      }),
    ).toEqual({ missing: [], unreadable: [] });
    // …and so a missing half of such a shape is reported.
    const { [P("a", "web/index.ts")]: _w, ...noWeb } = A;
    expect(
      (
        await exposures({
          ...noWeb,
          [P("a", "core/index.ts")]:
            `export * from "@plugins/infra/plugins/entity-extensions/core";\n`,
          [P("a", "shared/shape.ts")]:
            `import { defineExtensionShape as shape } from "../core";\nexport const trackShape = flag\n  ? shape({ exposes: { parent } })\n  : other;\n`,
        })
      ).missing,
    ).toEqual([
      "plugins/a/shared/shape.ts:3 — trackShape (web: FieldPresentation.Register)",
    ]);
  });

  test("an exposing shape no const binds is reported; one without `exposes` is not checked", async () => {
    expect(
      (
        await exposures({
          [P("a", "shared/shape.ts")]:
            `${ENTITY_CORE}register(defineExtensionShape({ exposes: { parent } }));\nexport const s = defineExtensionShape({ key: "k", fields });\n`,
        })
      ).missing,
    ).toEqual([
      "plugins/a/shared/shape.ts:2 — a exposing defineExtensionShape(…) call no `const` binds",
    ]);
  });

  test("options the check cannot read fail closed", async () => {
    expect(
      (
        await exposures({
          [P("a", "shared/shape.ts")]:
            `${ENTITY_CORE}export const s = defineExtensionShape(makeSpec());\n`,
        })
      ).unreadable,
    ).toEqual(["plugins/a/shared/shape.ts:2"]);
  });
});

describe("live:arms-registered", () => {
  const ARM = `${LIVE_CORE}export const buildArm = liveArm(runs, "build", {\n  label: "Build",\n  fields,\n});\n`;
  const SERVER = `import { buildArm as arm } from "../../core/arm";\nexport const kind = runsServed.arm(arm, {});\n`;
  const WEB = `${LIVE_WEB}import { buildArm } from "../core/arm";\nconst c = FieldPresentation.Register({ owner: buildArm });\n`;
  const A = {
    [P("a", "core/arm.ts")]: ARM,
    [P("a", "server/internal/kind.ts")]: SERVER,
    [P("a", "web/index.ts")]: WEB,
  };

  test("an arm bound by its server and registered by its web passes", async () => {
    expect(await arms(A)).toEqual({ missing: [], unreadable: [] });
  });

  test("a missing half — or one in another plugin, or test code — is named", async () => {
    const { [P("a", "web/index.ts")]: _w, ...noWeb } = A;
    expect((await arms(noWeb)).missing).toEqual([
      "plugins/a/core/arm.ts:2 — buildArm (web: FieldPresentation.Register)",
    ]);
    const { [P("a", "server/internal/kind.ts")]: _s, ...noServer } = A;
    expect((await arms(noServer)).missing).toEqual([
      "plugins/a/core/arm.ts:2 — buildArm (server: binding)",
    ]);
    const { [P("a", "server/internal/kind.ts")]: srv, ...rest } = A;
    expect(
      (await arms({ ...rest, [P("a", "server/internal/kind.test.ts")]: srv! }))
        .missing,
    ).toHaveLength(1);
  });

  test("a server naming another `buildArm` binds nothing; a namespace member does", async () => {
    expect(
      (
        await arms({
          ...A,
          [P("a", "server/internal/kind.ts")]:
            "const buildArm = 1;\nexport const kind = runsServed.arm(buildArm, {});\n",
        })
      ).missing,
    ).toEqual(["plugins/a/core/arm.ts:2 — buildArm (server: binding)"]);
    expect(
      await arms({
        ...A,
        [P("a", "server/internal/kind.ts")]:
          'import * as core from "../../core/arm";\nexport const kind = runsServed.arm(core.buildArm, {});\n',
      }),
    ).toEqual({ missing: [], unreadable: [] });
  });

  test("a registration through a helper's parameter fails closed", async () => {
    expect(
      await arms({
        ...A,
        [P("a", "web/index.ts")]:
          `${LIVE_WEB}export function present(owner) {\n  return FieldPresentation.Register({ owner });\n}\n`,
      }),
    ).toEqual({
      missing: [
        "plugins/a/core/arm.ts:2 — buildArm (web: FieldPresentation.Register)",
      ],
      unreadable: ["plugins/a/web/index.ts:3"],
    });
  });
});

describe("live:client-fields-resolved", () => {
  const DECL = `${LIVE_CORE}export const gitFields = clientFields(fileEntry, "git", {\n  fields,\n});\n`;
  const WEB = `${LIVE_WEB}import { gitFields } from "../core/fields";\nconst c = ClientFields.Resolve({ fields: gitFields, component: GitResolver });\n`;

  test("a declaration its own web resolves passes", async () => {
    expect(
      await clientFieldsOf({
        [P("a", "core/fields.ts")]: DECL,
        [P("a", "web/index.ts")]: WEB,
      }),
    ).toEqual({ missing: [], unreadable: [] });
  });

  test("no resolver — or one in another plugin, or test code — is named", async () => {
    expect(
      (await clientFieldsOf({ [P("a", "core/fields.ts")]: DECL })).missing,
    ).toEqual(["plugins/a/core/fields.ts:2 — gitFields"]);
    expect(
      (
        await clientFieldsOf({
          [P("a", "core/fields.ts")]: DECL,
          [P("b", "web/index.ts")]: WEB.replace(
            "../core/fields",
            "../../a/core/fields",
          ),
        })
      ).missing,
    ).toHaveLength(1);
    expect(
      (
        await clientFieldsOf({
          [P("a", "core/fields.ts")]: DECL,
          [P("a", "web/index.test.ts")]: WEB,
        })
      ).missing,
    ).toHaveLength(1);
  });

  test("a resolver reached through an aliased namespace import is read", async () => {
    expect(
      await clientFieldsOf({
        [P("a", "core/fields.ts")]: DECL,
        [P("a", "web/index.ts")]:
          'import * as live from "@plugins/network/plugins/live/web";\nimport { gitFields as g } from "../core/fields";\nconst c = live.ClientFields.Resolve({ fields: g });\n',
      }),
    ).toEqual({ missing: [], unreadable: [] });
  });
});
