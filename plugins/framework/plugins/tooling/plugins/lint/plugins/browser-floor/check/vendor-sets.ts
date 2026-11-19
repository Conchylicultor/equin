import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { webArtifactsDir } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/data-dirs";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { readdir } from "@plugins/packages/plugins/timed-fs/core";
import { pacedHeapEnv } from "@plugins/packages/plugins/heap-pacing/core";
import { vendorFloorScansDir } from "../data-dirs";

// ── browser-floor:vendor-sets ──────────────────────────────────────────────
// `no-api-above-floor` holds repo code to the floor's regular expressions; npm
// code is never linted, and the vendor build (esbuild, no target) neither
// lowers nor refuses a regex — no build can: a `v` flag, `(?i:…)` modifiers
// or duplicate named groups throw where the regex is created, in every older
// engine. So a dependency upgrade bringing one would break every page (or the
// website demo's worker) importing that package on a floor browser, silently.
//
// This check holds what ships instead: every vendor set of the host's
// web-artifact store — each set's entry files and `chunks/`, the npm code a
// page loads through the import map and a browser host's worker through its
// tree's `_vendor/` (a link to the same set). Host-scoped, because the store is
// the machine's, not the checkout's: main's hourly host audit runs it and
// files a report naming the package; `./equin check --scope host` runs it on
// demand. Not deploy-scoped: a build's check pass sees the dist that build
// replaces, so a failing verdict there would block the very build fixing it.
//
// The work is in a subprocess (`../lint/vendor-scan-probe.ts`), memoized per
// set: a set is write-once, so it is parsed once (~2 s for one set of ~30 MB;
// the store's every set on a host's first run). Not covered: APIs newer than
// the floor (`URL.canParse`) in npm code — libraries feature-test those, and
// untyped minified code cannot tell a guarded use from a bare one.

const ID = "browser-floor:vendor-sets";

const PROBE = path.join(import.meta.dir, "../lint/vendor-scan-probe.ts");

/**
 * The vendor sets: web-artifacts' `vendors/` subtree of its store (named in
 * its `core/internal/vendors.ts`, which this check does not import: its
 * source is the builder's identity).
 */
const vendorsDir = (): string => path.join(webArtifactsDir.path, "vendors");

interface VendorHit {
  file: string;
  line: number;
  column: number;
  regex: string;
  problem: string;
  source: string | null;
}

interface ProbeAnswer {
  digest: string;
  sets: {
    set: string;
    files: number;
    bytes: number;
    regexes: number;
    parsed: number;
    hits: VendorHit[];
  }[];
  dropped: number;
  ms: number;
}

async function listSets(): Promise<string[]> {
  try {
    return (await readdir(vendorsDir()))
      .filter((n) => n.startsWith("set."))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** The hits, one line per regex and source, naming every set holding it. */
function describe(answer: ProbeAnswer): string[] {
  const byRegex = new Map<string, { hit: VendorHit; at: string[] }>();
  for (const s of answer.sets) {
    for (const h of s.hits) {
      const key = `${h.source ?? h.file}\0${h.regex}\0${h.problem}`;
      let entry = byRegex.get(key);
      if (entry === undefined) byRegex.set(key, (entry = { hit: h, at: [] }));
      entry.at.push(`${s.set}/${h.file}:${h.line}:${h.column}`);
    }
  }
  return [...byRegex.values()].map(({ hit, at }) => {
    const where =
      at.length > 3
        ? `${at.slice(0, 3).join(", ")} and ${at.length - 3} more`
        : at.join(", ");
    return `${hit.source ?? "(no sourcemap)"}: ${hit.regex} ${hit.problem}\n      in ${where}`;
  });
}

export const vendorSetsCheck: Check = {
  id: ID,
  scope: "host",
  heavyChildren: {
    what: "a parse of each new vendor set's JS (~30 MB, ~2 s; memoized per set)",
  },
  description:
    "Every vendor set in the host's web-artifact store (the npm code pages and browser-host workers load) creates only regular expressions every browser of the floor can — no `v` flag, `(?i:…)` modifiers or duplicate named groups outside a feature test",
  async cacheSignature() {
    // The verdict is a function of the store's sets (each write-once) and of
    // the scanner's code, which the tree hash this is combined with covers.
    const sets = await listSets();
    return createHash("sha256").update(sets.join("\n")).digest("hex");
  },
  async run(ctx) {
    if ((await listSets()).length === 0) return { ok: true };
    const run = await ctx.grant.run(() =>
      spawnCaptured([process.execPath, PROBE], {
        // Parsing a set is a heavy process of its own, paced as one.
        env: pacedHeapEnv({ ...process.env, NO_COLOR: "1" }),
        stdin: JSON.stringify({
          vendorsDir: vendorsDir(),
          memoDir: vendorFloorScansDir.path,
        }),
        // ~2 s a set; a host's first run parses every set in the store (68
        // on a busy host: ~2 min under background priority). Ten minutes
        // only bounds a probe that never returns.
        timeoutMs: 600_000,
      }),
    );
    if (run.exitCode !== 0)
      return {
        ok: false,
        message: `${ID}: the probe exited ${run.exitCode}:\n${run.stderr.slice(-4000)}`,
      };
    const answer = JSON.parse(run.stdout) as ProbeAnswer;
    const parsed = answer.sets.filter((s) => s.parsed > 0);
    ctx.log?.(
      `${ID}: ${answer.sets.length} vendor set(s), ${parsed.length} parsed (${parsed.reduce((n, s) => n + s.parsed, 0)} files, ${parsed.reduce((n, s) => n + s.regexes, 0)} regexes) in ${answer.ms} ms; ${answer.dropped} memo(s) of pruned sets dropped`,
      "stdout",
    );
    const lines = describe(answer);
    if (lines.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${lines.length} regular expression(s) newer than the browser floor in npm code a vendor set bundles (${vendorsDir()}):\n    ${lines.join("\n    ")}`,
      hint: "Each line names the npm file the regex comes from (the chunk's sourcemap). It throws where it is created on a floor browser, failing every module importing that package — esbuild cannot lower it (a `target` turns a regex literal into `new RegExp(…)`, which throws the same). Pin the package to a version without it, patch it (`bun patch`), or move its import behind a feature test of the regex in our own code. A set no dist serves any more leaves the store at the hourly prune.",
    };
  },
};
