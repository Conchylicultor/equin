import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { createMemoryRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  describeWideKeys,
  keyWidths,
  MAX_UNUSED_KEY_MODULES,
} from "./key-width";

// A fixture repo's plugins directory: its paths are built from it, as data
// (no plugin of this checkout is named).
const P = "plugins";
const H = `${P}/heavy/core`;

// Every module graph keys its file facts by the real scan module, so a
// fixture set carries it.
const SCAN_PATH =
  "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts";
const SCAN = readFileSync(
  join(import.meta.dir, "../../../core/internal/scan-imports.ts"),
  "utf8",
);

function widthsOf(fixture: Record<string, string>, producers: string[]) {
  const files: Record<string, string> = { ...fixture, [SCAN_PATH]: SCAN };
  const paths = Object.keys(files).sort();
  const snapshot: RepoSnapshot = {
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
      // Any id unique to the content keys a record; the content itself is one.
      return c;
    },
  };
  return keyWidths(
    { snapshot, store: createMemoryRecordStore(), readOutside: () => null },
    producers,
  );
}

// A heavy barrel: one pure helper beside a module that loads `n` others.
function heavyBarrel(n: number): Record<string, string> {
  const files: Record<string, string> = {
    [`${H}/index.ts`]:
      'export { light } from "./light";\nexport { heavy } from "./heavy";',
    [`${H}/light.ts`]: "export const light = (s: string) => s;",
    [`${H}/heavy.ts`]: Array.from(
      { length: n },
      (_, i) => `import "./dep${i}";`,
    )
      .concat("export const heavy = 1;")
      .join("\n"),
  };
  for (let i = 0; i < n; i++) files[`${H}/dep${i}.ts`] = "export {};";
  return files;
}

const PRODUCER = `${P}/p/core/p.scan.ts`;

describe("keyWidths", () => {
  test("a name taken from a barrel reaches only the module defining it", async () => {
    const [w] = await widthsOf(
      {
        ...heavyBarrel(5),
        [PRODUCER]:
          'import { light } from "@plugins/heavy/core";\nexport const s = light;',
      },
      [PRODUCER],
    );
    expect(w!.keyed).toBe(9);
    expect(w!.unused).toEqual([
      `${H}/dep0.ts`,
      `${H}/dep1.ts`,
      `${H}/dep2.ts`,
      `${H}/dep3.ts`,
      `${H}/dep4.ts`,
      `${H}/heavy.ts`,
    ]);
    expect(w!.barrels).toEqual([
      {
        importer: PRODUCER,
        barrel: `${H}/index.ts`,
        names: ["light"],
        unused: 6,
      },
    ]);
  });

  test("a module with code of its own is taken whole, and a namespace import too", async () => {
    const [w] = await widthsOf(
      {
        ...heavyBarrel(3),
        [PRODUCER]:
          'import * as h from "@plugins/heavy/core";\nexport const s = h;',
      },
      [PRODUCER],
    );
    expect(w!.unused).toEqual([]);
  });

  test("a namespace re-exported by a barrel is taken whole", async () => {
    const [w] = await widthsOf(
      {
        ...heavyBarrel(3),
        [`${P}/ns/core/index.ts`]:
          'export * as heavyNs from "@plugins/heavy/core";',
        [PRODUCER]:
          'import { heavyNs } from "@plugins/ns/core";\nexport const s = heavyNs;',
      },
      [PRODUCER],
    );
    expect(w!.unused).toEqual([]);
  });

  test("a type-only import keys nothing it could call", async () => {
    const [w] = await widthsOf(
      {
        ...heavyBarrel(3),
        [PRODUCER]:
          'import { light, type heavy } from "@plugins/heavy/core";\nexport const s = light;',
      },
      [PRODUCER],
    );
    expect(w!.unused).toContain(`${H}/heavy.ts`);
  });
});

describe("describeWideKeys", () => {
  test("fails a producer over the bound, naming the barrel import", async () => {
    const widths = await widthsOf(
      {
        ...heavyBarrel(MAX_UNUSED_KEY_MODULES + 1),
        [PRODUCER]:
          'import { light } from "@plugins/heavy/core";\nexport const s = light;',
      },
      [PRODUCER],
    );
    const message = describeWideKeys(widths);
    expect(message).toContain(PRODUCER);
    expect(message).toContain(`takes { light } from ${H}/index.ts`);
  });

  test("passes a producer at the bound", async () => {
    const widths = await widthsOf(
      {
        ...heavyBarrel(MAX_UNUSED_KEY_MODULES - 1),
        [PRODUCER]:
          'import { light } from "@plugins/heavy/core";\nexport const s = light;',
      },
      [PRODUCER],
    );
    expect(describeWideKeys(widths)).toBeNull();
  });
});
