// Replicates drizzle-kit's schema loader: it `require()`s each schema-glob file
// synchronously under Bun (`bun --bun`). A `.ts` file whose import graph contains
// a top-level-await (async-only) module throws `require() async module …
// unsupported` here — exactly the failure drizzle-kit swallows with exit 0.
//
// Run as: bun --bun require-probe.ts [--tip <snapshot.json>] <absFile...>
// Emits { failures: { file, error }[], matchesTip: boolean | null }.
//
// --tip: when every file loaded, also answer whether the schema they declare
// IS the tip snapshot — drizzle-kit's own `generateDrizzleJson` over the
// loaded exports (the snapshot `generate` diffs against the tip), compared
// with the tip's body, key order and the two ids aside. Equal means a
// `generate` has nothing to emit; anything else is `false`, and drizzle-kit
// runs. null: not asked, or a file failed to load.
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { resolve } from "path";

const args = process.argv.slice(2);
let tip: string | null = null;
if (args[0] === "--tip") {
  tip = args[1] ?? null;
  if (tip === null) throw new Error("require-probe: --tip needs a path");
  args.splice(0, 2);
}

const failures: { file: string; error: string }[] = [];
// Every file's exports, each under its own key: drizzle-kit reads each file's
// exports separately, so two files exporting one name must not shadow.
const exports: Record<string, unknown> = {};
args.forEach((f, i) => {
  try {
    for (const [name, value] of Object.entries(require(f) as object))
      exports[`${i}:${name}`] = value;
  } catch (e) {
    failures.push({ file: f, error: String(e) });
  }
});

let matchesTip: boolean | null = null;
if (tip !== null && failures.length === 0) {
  // The comparison stands for `generate` only while the config adds nothing
  // the snapshot reads (casing, filters, entities): name every key it may hold.
  const config = (
    require(resolve(process.cwd(), "core/drizzle.config.ts")) as {
      default: Record<string, unknown>;
    }
  ).default;
  const known = new Set(["dialect", "schema", "out", "dbCredentials"]);
  const extra = Object.keys(config).filter((k) => !known.has(k));
  if (config.dialect !== "postgresql" || extra.length > 0)
    throw new Error(
      `require-probe: drizzle.config.ts has ${extra.length > 0 ? `keys ${extra.join(", ")}` : `dialect ${String(config.dialect)}`} the tip comparison does not pass to generateDrizzleJson — teach it, never compare without them`,
    );
  const { generateDrizzleJson } = require("drizzle-kit/api") as {
    generateDrizzleJson(imports: Record<string, unknown>): object;
  };
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  const body = (snapshot: object): string => {
    const {
      id: _id,
      prevId: _prevId,
      ...rest
    } = snapshot as Record<string, unknown>;
    return JSON.stringify(canonical(rest));
  };
  matchesTip =
    body(generateDrizzleJson(exports)) ===
    body(JSON.parse(readFileSync(tip, "utf8")) as object);
}

process.stdout.write(JSON.stringify({ failures, matchesTip }));
