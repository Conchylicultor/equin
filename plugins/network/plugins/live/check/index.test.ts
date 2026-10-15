import { describe, expect, test } from "bun:test";
import {
  unregisteredArms,
  unregisteredExposures,
  unresolvedClientFields,
} from "./index";

// Fixture files of made-up plugins `a` and `b` (spelled through a template, so
// the plugin-refs scan does not read them as references to real plugins).
const file = (plugin: string, path: string, src: string) => ({
  rel: `plugins/${plugin}/${path}`,
  src,
});

describe("live:exposures-registered", () => {
  const SHAPE =
    'export const trackShape = defineExtensionShape({\n  key: "taskId",\n  fields,\n  exposes: { parent, name: "track", fields: {} },\n});\n';
  const TABLE =
    'import { trackShape } from "../../shared/shape";\nexport const tasksTrack = defineExtension(_tasks, "track", trackShape);\n';
  const SERVER =
    'import { tasksTrack as ext } from "./internal/tables";\nconst x = [LiveColumns.Expose(ext)];\n';
  const WEB =
    'import { trackShape } from "../shared/shape";\nconst c = FieldPresentation.Register({\n  owner: trackShape.exposure,\n});\n';

  test("a shape folded by its server and registered by its web passes", () => {
    expect(
      unregisteredExposures(
        [file("a", "shared/shape.ts", SHAPE)],
        [
          file("a", "server/internal/tables.ts", TABLE),
          file("a", "server/index.ts", SERVER),
        ],
        [file("a", "web/index.ts", WEB)],
      ),
    ).toEqual([]);
  });

  test("a missing half — or one in another plugin, or in test code — is named", () => {
    const declared = [file("a", "shared/shape.ts", SHAPE)];
    const server = [
      file("a", "server/internal/tables.ts", TABLE),
      file("a", "server/index.ts", SERVER),
    ];
    expect(unregisteredExposures(declared, server, [])).toEqual([
      "plugins/a/shared/shape.ts:1 — trackShape (web: FieldPresentation.Register)",
    ]);
    expect(
      unregisteredExposures(declared, [], [file("a", "web/index.ts", WEB)]),
    ).toEqual([
      "plugins/a/shared/shape.ts:1 — trackShape (server: LiveColumns.Expose)",
    ]);
    // Another plugin's halves register nothing for `a`.
    expect(
      unregisteredExposures(
        declared,
        [
          file("b", "server/internal/tables.ts", TABLE),
          file("b", "server/index.ts", SERVER),
        ],
        [file("b", "web/index.ts", WEB)],
      ),
    ).toHaveLength(1);
    // A handle defined but never exposed folds nothing.
    expect(
      unregisteredExposures(
        declared,
        [file("a", "server/internal/tables.ts", TABLE)],
        [file("a", "web/index.ts", WEB)],
      ),
    ).toHaveLength(1);
    // Test code registers nothing.
    expect(
      unregisteredExposures(declared, server, [
        file("a", "web/__tests__/x.test.ts", WEB),
      ]),
    ).toHaveLength(1);
  });

  test("a shape, a handle or a registration wrapped over lines still reads", () => {
    expect(
      unregisteredExposures(
        [
          file(
            "a",
            "shared/shape.ts",
            'export const trackShape =\n  defineExtensionShape({\n    key: "taskId",\n    exposes: { parent },\n  });\n',
          ),
        ],
        [
          file(
            "a",
            "server/internal/tables.ts",
            'const tasksTrack =\n  defineExtension(\n    _tasks,\n    "track",\n    trackShape,\n  );\n',
          ),
          file("a", "server/index.ts", "LiveColumns.Expose(\n  tasksTrack,\n)"),
        ],
        [
          file(
            "a",
            "web/index.ts",
            "FieldPresentation.Register(\n  {\n    owner: trackShape.exposure,\n  },\n)",
          ),
        ],
      ),
    ).toEqual([]);
  });

  test("an exposing shape no const binds is reported, not skipped", () => {
    expect(
      unregisteredExposures(
        [
          file(
            "a",
            "shared/shape.ts",
            "register(defineExtensionShape({ exposes: { parent } }));",
          ),
        ],
        [],
        [],
      ),
    ).toEqual([
      "plugins/a/shared/shape.ts:1 — an exposing defineExtensionShape(…) call no `const` binds",
    ]);
  });

  test("a shape without `exposes`, or in test code, is not checked", () => {
    expect(
      unregisteredExposures(
        [
          file(
            "a",
            "shared/shape.ts",
            'export const s = defineExtensionShape({ key: "k", fields });\n',
          ),
          file("a", "shared/shape.test.ts", SHAPE),
        ],
        [],
        [],
      ),
    ).toEqual([]);
  });
});

describe("live:arms-registered", () => {
  const ARM =
    'import { runs } from "@plugins/runs/core";\nexport const buildArm = liveArm(runs, "build", {\n  label: "Build",\n  order: 10,\n  fields,\n});\n';
  const SERVER =
    'import { buildArm as arm } from "../../core";\nexport const kind = defineRunKind({ columns: arm });\n';
  const WEB =
    'import { buildArm } from "../core";\nconst c = FieldPresentation.Register({ owner: buildArm });\n';

  test("an arm bound by its server and registered by its web passes", () => {
    expect(
      unregisteredArms(
        [file("a", "core/arm.ts", ARM)],
        [file("a", "server/internal/kind.ts", SERVER)],
        [file("a", "web/index.ts", WEB)],
      ),
    ).toEqual([]);
  });

  test("a missing half — or one in another plugin, or test code — is named", () => {
    const declared = [file("a", "core/arm.ts", ARM)];
    expect(
      unregisteredArms(
        declared,
        [file("a", "server/internal/kind.ts", SERVER)],
        [],
      ),
    ).toEqual([
      "plugins/a/core/arm.ts:2 — buildArm (web: FieldPresentation.Register)",
    ]);
    expect(
      unregisteredArms(declared, [], [file("a", "web/index.ts", WEB)]),
    ).toEqual(["plugins/a/core/arm.ts:2 — buildArm (server: binding)"]);
    expect(
      unregisteredArms(
        declared,
        [file("b", "server/internal/kind.ts", SERVER)],
        [file("b", "web/index.ts", WEB)],
      ),
    ).toHaveLength(1);
    expect(
      unregisteredArms(
        declared,
        [file("a", "server/internal/kind.test.ts", SERVER)],
        [file("a", "web/index.ts", WEB)],
      ),
    ).toHaveLength(1);
  });
});

describe("live:client-fields-resolved", () => {
  const DECL =
    'import { fileEntry } from "./kind";\nexport const gitFields = clientFields(fileEntry, "git", {\n  fields,\n});\n';
  const WEB =
    'import { gitFields } from "../core";\nconst c = ClientFields.Resolve({ fields: gitFields, component: GitResolver });\n';

  test("a declaration its own web resolves passes", () => {
    expect(
      unresolvedClientFields(
        [file("a", "core/fields.ts", DECL)],
        [file("a", "web/index.ts", WEB)],
      ),
    ).toEqual([]);
  });

  test("no resolver — or one in another plugin, or test code — is named", () => {
    const declared = [file("a", "core/fields.ts", DECL)];
    expect(unresolvedClientFields(declared, [])).toEqual([
      "plugins/a/core/fields.ts:2 — gitFields",
    ]);
    expect(
      unresolvedClientFields(declared, [file("b", "web/index.ts", WEB)]),
    ).toHaveLength(1);
    expect(
      unresolvedClientFields(declared, [file("a", "web/index.test.ts", WEB)]),
    ).toHaveLength(1);
  });
});
