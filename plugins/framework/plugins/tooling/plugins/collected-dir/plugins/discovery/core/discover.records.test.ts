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
import { discoverCollectedDirsIn } from "./discover";

// Discovery's markers are plugin records (a fold over every candidate
// `core/*.ts`). A stored part must never outlive a change to the bytes it
// read: adding, changing or removing a marker re-answers on the next pass.

const pj = (rel: string): string => `plugins/${rel}`;
const BARREL = pj("zz-discover-fixture/core/index.ts");
const DECL = pj("zz-discover-fixture/core/dirs.ts");

let real: RepoSnapshot;
beforeAll(async () => {
  real = await loadRepoSnapshot(REPO_ROOT);
});

/** The fixture plugin's declared dirs, discovered over the checkout with it laid in. */
async function fixtureDirs(decl: string): Promise<string[]> {
  const found = await discoverCollectedDirsIn(
    overlaySnapshot(real, { [BARREL]: "export {};\n", [DECL]: decl }),
  );
  return found
    .filter((d) => d.ownerDir.endsWith("/zz-discover-fixture"))
    .map((d) => `${d.dir}:${d.membership}`);
}

describe("collected-dir discovery's records", () => {
  test("a marker edit re-answers, a revert answers as before", async () => {
    installRecordStore(createMemoryRecordStore());
    expect(await fixtureDirs("export const x = 1;\n")).toEqual([]);
    expect(await fixtureDirs('defineCollectedDir("check");\n')).toEqual([
      "check:composition",
    ]);
    expect(
      await fixtureDirs(
        'defineCollectedDir("check", { membership: "checkout" });\n',
      ),
    ).toEqual(["check:checkout"]);
    expect(await fixtureDirs("export const x = 1;\n")).toEqual([]);
  });

  test("the whole answer is the set's own, in path order", async () => {
    installRecordStore(createMemoryRecordStore());
    const cold = await discoverCollectedDirsIn(real);
    const warm = await discoverCollectedDirsIn(real);
    expect(warm).toEqual(cold);
    expect(cold.length).toBeGreaterThan(0);
  });
});
