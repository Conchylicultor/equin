import { expect, test } from "bun:test";
import type { DataDir } from "@plugins/infra/plugins/paths/core";
import type { FileRoot, FileRootSpec } from "../../server";
import { rootBindingProblems } from "./bindings";

const spec: FileRootSpec = { id: "apps.prototypes", dir: "apps/prototypes" };
const root = { id: spec.id, spec } as FileRoot;
const dirOf = (kind: string, name: string) =>
  ({ spec: { kind, name } }) as unknown as DataDir;

test("one location naming the root's dir binds it", () => {
  expect(
    rootBindingProblems(
      [spec],
      [{ root, dataDir: dirOf("apps", "prototypes") }],
    ),
  ).toEqual([]);
});

test("an unbound, twice-bound or misbound root fails boot with a reason", () => {
  expect(rootBindingProblems([spec], [])[0]).toContain(
    "has no FileRootLocation",
  );
  const twice = { root, dataDir: dirOf("apps", "prototypes"), _pluginId: "x" };
  expect(rootBindingProblems([spec], [twice, twice])[0]).toContain(
    "has 2 FileRootLocations (x, x)",
  );
  expect(
    rootBindingProblems(
      [spec],
      [
        {
          root,
          dataDir: dirOf("cache", "prototypes-thumbnails"),
          _pluginId: "y",
        },
      ],
    )[0],
  ).toContain('y binds it to "cache/prototypes-thumbnails"');
});
