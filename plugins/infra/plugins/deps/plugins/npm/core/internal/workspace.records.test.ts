import { beforeAll, describe, expect, test } from "bun:test";
import {
  createMemoryRecordStore,
  installRecordStore,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import { overlaySnapshot } from "@plugins/plugin-meta/plugins/plugin-records/core/testing";
import {
  loadRepoSnapshot,
  type RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { readWorkspace } from "./workspace";

// Every manifest of the workspace is a plugin record (a fold over every
// package.json). A stored part must never outlive a change to its bytes: an
// edited dependency or policy re-answers on the next read.

// Through `pj`, never a bare `plugins/<seg>/…` literal: the repo's
// `plugin-refs-resolve` check resolves every such literal to a real plugin.
const pj = (rel: string): string => `plugins/${rel}`;
const MANIFEST = pj("zz-workspace-fixture/package.json");

let real: RepoSnapshot;
beforeAll(async () => {
  real = await loadRepoSnapshot(REPO_ROOT);
});

async function fixtureOf(manifest: object) {
  const ws = await readWorkspace(
    overlaySnapshot(real, { [MANIFEST]: JSON.stringify(manifest) }),
  );
  return {
    declared: ws.declared
      .filter((d) => d.manifest === MANIFEST)
      .map((d) => `${d.workspace} ${d.section} ${d.name}@${d.raw}`),
    policies: ws.policies.filter((p) => p.manifest === MANIFEST).length,
    policyErrors: ws.policyErrors.filter((p) => p.manifest === MANIFEST).length,
  };
}

describe("readWorkspace's records", () => {
  test("an edited manifest re-answers", async () => {
    installRecordStore(createMemoryRecordStore());
    expect(
      await fixtureOf({ name: "zz", dependencies: { "left-pad": "1.0.0" } }),
    ).toEqual({
      declared: ["zz dependencies left-pad@1.0.0"],
      policies: 0,
      policyErrors: 0,
    });
    expect(
      await fixtureOf({
        name: "zz",
        devDependencies: { "left-pad": "^1.0.0" },
        dependencyPolicy: { nonsense: true },
      }),
    ).toEqual({
      declared: ["zz devDependencies left-pad@^1.0.0"],
      policies: 0,
      policyErrors: 1,
    });
    expect(await fixtureOf({})).toEqual({
      declared: [],
      policies: 0,
      policyErrors: 0,
    });
  });

  test("the root manifest comes first, the plugins' in the set's order", async () => {
    installRecordStore(createMemoryRecordStore());
    const ws = await readWorkspace(real);
    const order = [...new Set(ws.declared.map((d) => d.manifest))];
    expect(order[0]).toBe("package.json");
    expect(order.slice(1)).toEqual([...order.slice(1)].sort());
  });
});
