import { beforeAll, describe, expect, test } from "bun:test";
import {
  createMemoryRecordStore,
  foldRepoFiles,
  gitBlobId,
  installRecordStore,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  loadRepoSnapshot,
  type RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { declarationsFold } from "./declarations.scan";
import { stylesheetReadsFold } from "./stylesheet-reads.scan";

// The check's answer is two folds kept as records host-wide: what each file
// declares, and — keyed by the declared set — what each stylesheet reads. A
// stored part must never outlive a change to what it read: its own bytes, or
// the declared set (another file's bytes) it was judged against.

const STATE = "zz-fold-fixture/web/state.ts";
const SHEET = "zz-fold-fixture/web/sheet.css";

let real: RepoSnapshot;
beforeAll(async () => {
  // The real checkout underneath: the scan modules' own closures key the
  // records, so they must be members of the set.
  real = await loadRepoSnapshot(REPO_ROOT);
});

/** The checkout with the fixture files laid over it. */
function withFixture(files: Record<string, string>): RepoSnapshot {
  const has = (p: string) => p in files || real.has(p);
  const paths = [...new Set([...real.all(), ...Object.keys(files)])].sort();
  return {
    root: real.root,
    all: () => paths,
    has,
    under: (dir) => paths.filter((p) => p.startsWith(`${dir}/`)),
    glob: () => {
      throw new Error("unused");
    },
    read: (p) => (p in files ? Promise.resolve(files[p]!) : real.read(p)),
    blobOf: (p) => (p in files ? gitBlobId(files[p]!) : real.blobOf(p)),
  };
}

/** Both folds over the fixture, against the installed record store. */
async function verdictOf(
  files: Record<string, string>,
): Promise<{ attributes: string[]; reads: string[] }> {
  const snapshot = withFixture(files);
  const declared = await foldRepoFiles(
    snapshot,
    [STATE],
    declarationsFold,
    null,
  );
  const context = {
    attributes: [...new Set(declared.attributes)].sort(),
    unreadable: declared.unreadable,
  };
  const reads = await foldRepoFiles(
    snapshot,
    [SHEET],
    stylesheetReadsFold,
    context,
  );
  return { attributes: context.attributes, reads };
}

describe("script-state:no-stylesheet-reads' folds", () => {
  test("declaring an attribute re-judges a stylesheet whose bytes did not move", async () => {
    installRecordStore(createMemoryRecordStore());
    const sheet = "[data-zz-b] .x { color: red; }\n";
    const before = await verdictOf({
      [STATE]: 'export const A = defineScriptState("data-zz-a");\n',
      [SHEET]: sheet,
    });
    expect(before).toEqual({ attributes: ["data-zz-a"], reads: [] });

    // Same store, same sheet bytes: only another file's declaration changed.
    const after = await verdictOf({
      [STATE]: 'export const B = defineScriptState("data-zz-b");\n',
      [SHEET]: sheet,
    });
    expect(after.attributes).toEqual(["data-zz-b"]);
    expect(after.reads).toEqual([
      `  ${SHEET}:1 — [data-zz-b (reads data-zz-b)`,
    ]);
  });

  test("editing the stylesheet re-reads it under the same declarations", async () => {
    installRecordStore(createMemoryRecordStore());
    const state = 'export const B = defineScriptState("data-zz-b");\n';
    const hit = await verdictOf({
      [STATE]: state,
      [SHEET]: "[data-zz-b] .x {}\n",
    });
    expect(hit.reads).toHaveLength(1);
    const fixed = await verdictOf({
      [STATE]: state,
      [SHEET]: ".x {}\n",
    });
    expect(fixed.reads).toEqual([]);
  });
});
