import { describe, expect, test } from "bun:test";
import { unregisteredExposures, unservedHandles } from "./index";

// Fixture files of made-up plugins `a` and `b` (spelled through a template, so
// the plugin-refs scan does not read them as references to real plugins).
const file = (plugin: string, path: string, src: string) => ({
  rel: `plugins/${plugin}/${path}`,
  src,
});

const DECL = 'export const playCols = liveColumns(lib, "p", {\n  row,\n});\n';

describe("live:contributed-columns-served", () => {
  test("a handle served by its own plugin's server passes", () => {
    expect(
      unservedHandles(
        [file("a", "core/columns.ts", DECL)],
        [
          file(
            "a",
            "server/index.ts",
            "LiveColumns.Serve(serveColumns(playCols, { join }))",
          ),
        ],
      ),
    ).toEqual([]);
  });

  test("a handle nothing serves — or only another plugin serves — is named", () => {
    const declared = [file("a", "core/columns.ts", `\n\n${DECL}`)];
    expect(unservedHandles(declared, [])).toEqual([
      "plugins/a/core/columns.ts:3 — playCols",
    ]);
    expect(
      unservedHandles(declared, [
        file("b", "server/index.ts", "serveColumns(playCols, { join })"),
      ]),
    ).toHaveLength(1);
    // A prefix of another name is not it.
    expect(
      unservedHandles(declared, [
        file("a", "server/index.ts", "serveColumns(playColsOld, { join })"),
      ]),
    ).toHaveLength(1);
    // A serve in a server test serves nothing.
    expect(
      unservedHandles(declared, [
        file("a", "server/internal/x.test.ts", "serveColumns(playCols, {})"),
      ]),
    ).toHaveLength(1);
    // A call in a comment serves nothing.
    expect(
      unservedHandles(declared, [
        file("a", "server/index.ts", "// serveColumns(playCols, { join })"),
      ]),
    ).toHaveLength(1);
  });

  test("a declaration or a serve wrapped over lines, and an unexported handle, still read", () => {
    const wrapped = [
      file(
        "a",
        "core/columns.ts",
        'const playCols =\n  liveColumns(lib, "p", { row });\n',
      ),
    ];
    expect(
      unservedHandles(wrapped, [
        file(
          "a",
          "server/index.ts",
          "LiveColumns.Serve(\n  serveColumns(\n    playCols,\n    { join },\n  ),\n)",
        ),
      ]),
    ).toEqual([]);
  });

  test("a serve under an import alias serves the handle it aliases", () => {
    const declared = [file("a", "core/columns.ts", DECL)];
    const serving = (src: string) => [file("a", "server/index.ts", src)];
    expect(
      unservedHandles(
        declared,
        serving(
          'import { playCols as pc } from "../core";\nserveColumns(pc, { join });',
        ),
      ),
    ).toEqual([]);
    // The alias's own name is not a handle.
    expect(
      unservedHandles(
        [file("a", "core/columns.ts", DECL.replace("playCols", "pc"))],
        serving(
          'import { playCols as pc } from "../core";\nserveColumns(pc, { join });',
        ),
      ),
    ).toHaveLength(1);
  });

  test("a liveColumns call no const binds is reported, not skipped", () => {
    expect(
      unservedHandles(
        [file("a", "core/columns.ts", 'register(liveColumns(lib, "p", {}));')],
        [],
      ),
    ).toEqual([
      "plugins/a/core/columns.ts:1 — a liveColumns(…) call no `const` binds",
    ]);
  });
});

describe("live:exposures-registered", () => {
  const SHAPE =
    'export const trackShape = defineExtensionShape({\n  key: "taskId",\n  fields,\n  exposes: { parent, name: "track", fields: {} },\n});\n';
  const TABLE =
    'import { trackShape } from "../../shared/shape";\nexport const tasksTrack = defineExtension(_tasks, "track", trackShape);\n';
  const SERVER =
    'import { tasksTrack as ext } from "./internal/tables";\nconst x = [LiveColumns.Expose(ext)];\n';
  const WEB =
    'import { trackShape } from "../shared/shape";\nconst c = LiveExposures.Register({\n  exposure: trackShape.exposure,\n});\n';

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
      "plugins/a/shared/shape.ts:1 — trackShape (web: LiveExposures.Register)",
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
