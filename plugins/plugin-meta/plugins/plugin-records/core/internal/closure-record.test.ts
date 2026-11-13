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
        code: ["file:///repo/producer.ts"],
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

/** Whether the producer ran, per file set, for a record over `data`. */
async function dataRunsOver(
  sets: Record<string, string>[],
  code: string,
): Promise<boolean[]> {
  installRecordStore(createMemoryRecordStore());
  const ran: boolean[] = [];
  for (const files of sets) {
    let did = false;
    const r = await closureRecord(
      snapshotOf(files),
      { name: "test:data", code: [code], data: ["entry.ts"], input: null },
      async () => {
        did = true;
        return { ok: true, value: 1 };
      },
    );
    expect(r.ok).toBe(true);
    ran.push(did);
  }
  return ran;
}

describe("closureRecord code and data", () => {
  test("moves with the producer's code and with every module of the data's closure", async () => {
    expect(
      await dataRunsOver(
        [
          base,
          { ...base },
          // Reached by the data's static import.
          { ...base, "a.ts": "export const a = 2;" },
          // Reached by the data's dynamic import (a loaded process runs it).
          {
            ...base,
            "a.ts": "export const a = 2;",
            "lazy.ts": "export const z = 2;",
          },
          // The producer edited (it lives in the set here: a fixture's own code).
          {
            ...base,
            "a.ts": "export const a = 2;",
            "lazy.ts": "export const z = 2;",
            "producer.ts": "export const how = 2;",
          },
        ],
        "file:///repo/producer.ts",
      ),
    ).toEqual([true, false, true, true, true]);
  });

  test("a producer of this checkout is read from it, never from a copy the set holds", async () => {
    // This test module is the producer: it lives in the running checkout, not
    // in the fixture at /repo — which holds no copy of it, or a stale one.
    const self = import.meta.url;
    const rel = new URL(self).pathname.slice(
      new URL(self).pathname.indexOf("/plugins/") + 1,
    );
    expect(
      await dataRunsOver(
        [
          base,
          { ...base, [rel]: "a stale copy of the producer" },
          { ...base, [rel]: "another stale copy" },
        ],
        self,
      ),
    ).toEqual([true, false, false]);
  });

  test("a record names its producer code", () => {
    installRecordStore(createMemoryRecordStore());
    expect(
      closureRecord(
        snapshotOf(base),
        { name: "test:none", code: [], data: ["entry.ts"], input: null },
        async () => ({ ok: true, value: 1 }),
      ),
    ).rejects.toThrow("names no producer code");
  });
});
