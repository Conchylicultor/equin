import { describe, expect, test } from "bun:test";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { closureRecord } from "./closure-record";
import { fileSetClosure } from "./file-set-closure";
import { gitBlobId } from "./keys";
import { createMemoryRecordStore, installRecordStore } from "./store";

function snapshotOf(files: Record<string, string>): RepoSnapshot {
  const paths = Object.keys(files).sort();
  return {
    root: asAppPath("/repo"),
    all: () => paths,
    has: (p) => p in files,
    under: (dir) => paths.filter((p) => p.startsWith(`${dir}/`)),
    glob: () => {
      throw new Error("unused");
    },
    read: (p) => Promise.resolve(files[p] ?? null),
    blobOf: (p) => {
      const c = files[p];
      if (c === undefined) throw new Error(`not a member: ${p}`);
      return gitBlobId(c);
    },
  };
}

const base = {
  "producer.ts": "export const how = 1;",
  "entry.ts":
    'import { a } from "./a";\nexport const lazy = () => import("./lazy");\nexport default a;',
  "a.ts": "export const a = 1;",
  "lazy.ts": "export const z = 1;",
};

/** How many times the producer ran over a sequence of file sets. */
async function runsOver(sets: Record<string, string>[]): Promise<boolean[]> {
  installRecordStore(createMemoryRecordStore());
  const ran: boolean[] = [];
  for (const files of sets) {
    const repo = snapshotOf(files);
    const { closure } = await fileSetClosure(repo, ["entry.ts"]);
    let did = false;
    const r = await closureRecord(
      repo,
      {
        name: "test:bundled",
        modules: ["producer.ts"],
        bundled: closure,
        input: null,
      },
      async () => {
        did = true;
        return { ok: true, value: [...closure.modules].sort() };
      },
    );
    expect(r.ok).toBe(true);
    ran.push(did);
  }
  return ran;
}

describe("closureRecord bundled", () => {
  test("keys a bundle on its closure's content, edges and producer — not on what it cuts", async () => {
    expect(
      await runsOver([
        base,
        // Same content: a lookup.
        { ...base },
        // Behind the cut `import()`: never parsed, still a lookup.
        { ...base, "lazy.ts": "export const z = 2;" },
        // A member edited.
        {
          ...base,
          "lazy.ts": "export const z = 2;",
          "a.ts": "export const a = 2;",
        },
        // The producer edited.
        {
          ...base,
          "lazy.ts": "export const z = 2;",
          "a.ts": "export const a = 2;",
          "producer.ts": "export const how = 2;",
        },
      ]),
    ).toEqual([true, false, false, true, true]);
  });

  test("a specifier resolving to another file answers again", async () => {
    const moved = { ...base, "a/index.ts": "export const a = 1;" };
    delete (moved as Record<string, string>)["a.ts"];
    expect(await runsOver([base, moved])).toEqual([true, true]);
  });
});
