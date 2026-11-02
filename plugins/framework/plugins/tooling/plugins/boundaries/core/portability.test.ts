/**
 * `serverPortability` over a fixture tree on disk, measured with the real
 * union build: an import cycle, a type-only import and a dynamic import (both
 * erase from the static closure), a host global read as a value, the offender
 * chain (a frontier, pruned per foreign plugin), an in-repo type-only import of
 * a tainted barrel (no taint), and rule 3 — a host service with no portable
 * provider taints the module declaring it, while one with a portable provider
 * does not, over as many rounds as the providers' own taint takes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serverPortability, type ServerPortability } from "./portability";

// A fixture module under a made-up plugin (built, not spelled, so the
// plugin-reference locator does not read it as a path into this repo).
const at = (plugin: string, rest: string): string =>
  ["plugins", plugin, rest].join("/");
const barrel = (p: string): string => at(p, "server/index.ts");

const FILES: Record<string, string> = {
  "tsconfig.base.json": JSON.stringify({
    compilerOptions: { paths: { "@fixture/*": ["plugins/*"] } },
  }),
  // a ↔ b: a cycle, and b needs the computer — so a does, through x.
  [at("a", "server/index.ts")]:
    `import { x } from "./internal/x";\nexport default { x };\n`,
  [at("a", "server/internal/x.ts")]:
    `import { y } from "../../../b/server";\nexport const x = 1 + y;\n`,
  [at("b", "server/index.ts")]:
    `import "../../a/server/internal/x";\nimport { readFileSync } from "node:fs";\nexport const y = 2;\nexport const read = readFileSync;\nexport default {};\n`,
  // Type-only imports erase, and a dynamic import is cut.
  [at("c", "server/index.ts")]:
    `import type { Stats } from "node:fs";\nimport { type Dirent } from "node:fs";\nexport type Both = Stats | Dirent;\nexport const later = () => import("../../b/server");\nexport default {};\n`,
  // A host global read as a value.
  [at("d", "server/index.ts")]:
    `export const bytes = Buffer.from("x");\nexport default {};\n`,
  // Host services: Svc has a portable provider (g), Svc2 only a tainted one (h).
  [at("f", "core/index.ts")]:
    `export const defineHostService = <T,>(id: string): { id: string; provide(v: T): unknown } => ({ id, provide: (v) => v });\n`,
  [at("e", "core/index.ts")]:
    `import { defineHostService } from "../../f/core";\nexport const Svc = defineHostService<number>("e.svc");\n`,
  [at("e", "server/index.ts")]:
    `import { Svc } from "../core";\nexport default { svc: Svc };\n`,
  [at("g", "server/index.ts")]:
    `import { Svc } from "../../e/core";\nexport default { contributions: [Svc.provide(1)] };\n`,
  [at("k", "core/index.ts")]:
    `import { defineHostService } from "../../f/core";\nexport const Svc2 = defineHostService<number>("k.svc2");\n`,
  [at("k", "server/index.ts")]:
    `import { Svc2 } from "../core";\nexport default { svc: Svc2 };\n`,
  [at("h", "server/index.ts")]:
    `import { Svc2 } from "../../k/core";\nimport { hostname } from "node:os";\nexport default { contributions: [Svc2.provide(hostname().length)] };\n`,
  // Rule 3 over two rounds: S1's only provider (q) is tainted by an import, so
  // S1's declarer (p/core) is tainted in round 1; S2's only provider (s)
  // imports p/core, so it is tainted only after round 1 — and S2's declarer
  // (r/core), with r/server loading it, only in round 2.
  [at("p", "core/index.ts")]:
    `import { defineHostService } from "../../f/core";\nexport const S1 = defineHostService<number>("p.s1");\n`,
  [at("q", "server/index.ts")]:
    `import { S1 } from "../../p/core";\nimport { cpus } from "node:os";\nexport default { contributions: [S1.provide(cpus().length)] };\n`,
  [at("r", "core/index.ts")]:
    `import { defineHostService } from "../../f/core";\nexport const S2 = defineHostService<number>("r.s2");\n`,
  [at("r", "server/index.ts")]:
    `import { S2 } from "../core";\nexport default { svc: S2 };\n`,
  [at("s", "server/index.ts")]:
    `import { S1 } from "../../p/core";\nimport { S2 } from "../../r/core";\nexport default { s1: S1, contributions: [S2.provide(2)] };\n`,
  // The frontier, pruned: m reaches two seeds of its own plugin (both named),
  // two seeds of plugin n (one named), one of o, and t's seed only through
  // n's server barrel (a seed itself, so t is never named).
  [at("m", "server/index.ts")]:
    `import { one } from "./internal/one";\nimport { two } from "./internal/two";\nimport { n } from "../../n/server";\nimport { nc } from "../../n/core";\nimport { o } from "../../o/server";\nexport default { one, two, n, nc, o };\n`,
  [at("m", "server/internal/one.ts")]:
    `import { readFileSync } from "node:fs";\nexport const one = readFileSync;\n`,
  [at("m", "server/internal/two.ts")]:
    `import { tmpdir } from "node:os";\nexport const two = tmpdir;\n`,
  [at("n", "server/index.ts")]:
    `import { t } from "../../t/server";\nimport { spawn } from "node:child_process";\nexport const n = [t, spawn];\nexport default {};\n`,
  [at("n", "core/index.ts")]:
    `import { createHash } from "node:crypto";\nexport const nc = createHash;\n`,
  [at("o", "server/index.ts")]:
    `import { connect } from "node:net";\nexport const o = connect;\nexport default {};\n`,
  [at("t", "server/index.ts")]:
    `import { join } from "node:path";\nexport const t = join;\nexport default {};\n`,
  // An in-repo type-only import of a tainted barrel erases: u stays portable.
  [at("u", "server/index.ts")]:
    `import type { y } from "../../b/server";\nimport { type read } from "../../b/server";\nexport type Y = typeof y | typeof read;\nexport default {};\n`,
};

const BARRELS = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "g",
  "h",
  "k",
  "m",
  "n",
  "o",
  "q",
  "r",
  "s",
  "t",
  "u",
].map(barrel);

let root: string;
let portability: ServerPortability;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "portability-"));
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  portability = await serverPortability(root, BARRELS, async (p) =>
    readFileSync(join(root, p), "utf8"),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("serverPortability", () => {
  test("derives each barrel's portability from its closure", () => {
    const portable = BARRELS.filter((b) => portability.isPortable(b));
    expect(portable).toEqual([
      barrel("c"),
      barrel("e"),
      barrel("g"),
      barrel("u"),
    ]);
  });

  test("names the frontier offender with the chain through the cycle", () => {
    expect(portability.offenders(barrel("a"))).toEqual([
      {
        module: barrel("b"),
        needs: ["node:fs"],
        chain: [barrel("a"), at("a", "server/internal/x.ts"), barrel("b")],
      },
    ]);
  });

  test("a host global read as a value needs the computer", () => {
    expect(portability.offenders(barrel("d"))).toEqual([
      { module: barrel("d"), needs: ["global Buffer"], chain: [barrel("d")] },
    ]);
  });

  test("a service whose only provider is not portable taints its declaration", () => {
    expect(portability.offenders(barrel("k"))).toEqual([
      {
        module: at("k", "core/index.ts"),
        needs: [
          'host service "k.svc2", which no portable `server/` barrel provides',
        ],
        chain: [barrel("k"), at("k", "core/index.ts")],
      },
    ]);
  });

  test("rule 3 runs to a fixpoint: a provider tainted only by round 1 taints its service in round 2", () => {
    // s itself: tainted through p/core (round 1); the r/core it also loads
    // carries the round-2 need.
    expect(portability.offenders(barrel("s"))).toEqual([
      {
        module: at("p", "core/index.ts"),
        needs: [
          'host service "p.s1", which no portable `server/` barrel provides',
        ],
        chain: [barrel("s"), at("p", "core/index.ts")],
      },
      {
        module: at("r", "core/index.ts"),
        needs: [
          'host service "r.s2", which no portable `server/` barrel provides',
        ],
        chain: [barrel("s"), at("r", "core/index.ts")],
      },
    ]);
    expect(portability.offenders(barrel("r"))).toEqual([
      {
        module: at("r", "core/index.ts"),
        needs: [
          'host service "r.s2", which no portable `server/` barrel provides',
        ],
        chain: [barrel("r"), at("r", "core/index.ts")],
      },
    ]);
  });

  test("the frontier keeps every own-plugin seed and one per foreign plugin, never a seed behind a seed", () => {
    const found = portability.offenders(barrel("m"));
    const modules = found.map((o) => o.module);
    // Own plugin: both seeds.
    expect(modules).toContain(at("m", "server/internal/one.ts"));
    expect(modules).toContain(at("m", "server/internal/two.ts"));
    // Plugin n: one of its two seeds, whichever the walk met first.
    const ofN = modules.filter((m) => m.startsWith(at("n", "")));
    expect(ofN).toHaveLength(1);
    expect([at("n", "server/index.ts"), at("n", "core/index.ts")]).toContain(
      ofN[0]!,
    );
    // Plugin o's seed; t's only behind n's seed, so never named.
    expect(modules).toContain(barrel("o"));
    expect(modules).not.toContain(barrel("t"));
    expect(found).toHaveLength(4);
    for (const o of found) {
      expect(o.chain[0]).toBe(barrel("m"));
      expect(o.chain.at(-1)).toBe(o.module);
    }
  });

  test("an in-repo type-only import of a tainted barrel does not taint", () => {
    expect(portability.isPortable(barrel("b"))).toBe(false);
    expect(portability.isPortable(barrel("u"))).toBe(true);
  });

  test("offenders throws for a portable barrel, and both throw for one not measured", () => {
    expect(() => portability.offenders(barrel("c"))).toThrow("it is portable");
    expect(() => portability.isPortable(barrel("zz"))).toThrow(
      "is not one of the 16 server barrels measured",
    );
  });
});
