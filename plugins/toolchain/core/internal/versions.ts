import {
  heldBy,
  holdProblems,
  type Hold,
} from "@plugins/infra/plugins/deps/plugins/updates/core";
import { HOLDS_FILE, TOOLS } from "./tools";

/**
 * An exact release as mise names one: dot-separated numbers, the last of which
 * may carry a letter suffix (`3.7c`). Excludes channels (`stable`), prereleases
 * (`1.5.0-canary.1`) and prefixes a request might use (`1.24` resolves, but a
 * lock never records one for these tools).
 */
const EXACT_RELEASE = /^\d+(?:\.\d+)+[a-z]?$/;

export function isExactRelease(version: string): boolean {
  return EXACT_RELEASE.test(version);
}

/** A release, or a floor like `1.24`, as comparable parts. */
function parts(version: string): Array<{ n: number; suffix: string }> {
  return version.split(".").map((part) => {
    const match = /^(\d+)(.*)$/.exec(part);
    if (match === null)
      throw new Error(`Not a comparable version: "${version}"`);
    return { n: Number(match[1]), suffix: match[2] ?? "" };
  });
}

/**
 * Negative when `a` is older than `b`. Missing trailing parts count as `0`, so
 * the floor `1.24` equals `1.24.0`; a letter suffix sorts after no suffix, so
 * `3.7` < `3.7a` < `3.7c`.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? { n: 0, suffix: "" };
    const y = pb[i] ?? { n: 0, suffix: "" };
    if (x.n !== y.n) return x.n - y.n;
    if (x.suffix !== y.suffix) return x.suffix < y.suffix ? -1 : 1;
  }
  return 0;
}

/**
 * Every `version` recorded per tool in a `mise.lock`. A lock lists each tool as
 * one or more `[[tools.<name>]]` array entries, each opening with its
 * `version = "…"`; the per-platform subtables (`[tools.<name>."platforms.…"]`)
 * carry no version and are skipped.
 */
export function parseMiseLock(text: string): Map<string, string[]> {
  const versions = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const entry = /^\[\[tools\.([A-Za-z0-9_-]+)\]\]\s*$/.exec(line);
    const entryName = entry?.[1];
    if (entryName !== undefined) {
      current = entryName;
      if (!versions.has(current)) versions.set(current, []);
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    const version = /^version\s*=\s*"([^"]*)"/.exec(line)?.[1];
    if (version !== undefined && current !== null)
      versions.get(current)?.push(version);
  }
  return versions;
}

/**
 * `mise.lock` with `tool` moved to `version`: the entry's version line
 * rewritten and its per-platform subtables dropped, since their checksums and
 * URLs name the old release. `mise lock` regenerates them afterwards.
 */
export function setLockedVersion(
  text: string,
  tool: string,
  version: string,
): string {
  const out: string[] = [];
  let inEntry = false;
  let inPlatforms = false;
  let found = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) {
      inEntry = line.trim() === `[[tools.${tool}]]`;
      inPlatforms = line.startsWith(`[tools.${tool}.`);
      if (inEntry) found = true;
    }
    if (inPlatforms) continue;
    if (inEntry && /^version\s*=/.test(line)) {
      out.push(`version = "${version}"`);
      continue;
    }
    out.push(line);
  }
  if (!found) throw new Error(`mise.lock has no [[tools.${tool}]] entry`);
  // Dropping a subtable can leave runs of blank lines behind.
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * `mise.lock` with a first entry for `tool` at `version`, for a tool
 * `mise.toml` has just started declaring: the version and the backend
 * (`mise tool <name> --backend`) — `mise lock` fills in the per-platform
 * subtables afterwards, but not a missing backend line.
 */
export function addLockedTool(
  text: string,
  tool: string,
  version: string,
  backend: string,
): string {
  if (parseMiseLock(text).has(tool))
    throw new Error(`mise.lock already has a [[tools.${tool}]] entry`);
  return `${text.replace(/\n*$/, "")}\n\n[[tools.${tool}]]\nversion = "${version}"\nbackend = "${backend}"\n`;
}

/**
 * The `key = "value"` requests in `mise.toml`'s `[tools]` table. Anchored to the
 * table, so a same-named key under another section is never read as a tool.
 */
export function parseMiseToolRequests(text: string): Map<string, string> {
  const requests = new Map<string, string>();
  const opens = /^\[tools\]\s*$/m.exec(text);
  if (opens === null) return requests;
  const after = text.slice(opens.index + opens[0].length);
  const next = /^\[/m.exec(after);
  const table = next === null ? after : after.slice(0, next.index);
  for (const line of table.split("\n")) {
    const [, key, value] =
      /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line) ?? [];
    if (key !== undefined && value !== undefined) requests.set(key, value);
  }
  return requests;
}

/**
 * What is wrong with a `mise.toml` + `mise.lock` pair, one sentence per
 * problem; empty when the pair is sound. Pure — the caller reads the files.
 */
export function lockProblems(
  requests: ReadonlyMap<string, string>,
  locked: ReadonlyMap<string, readonly string[]>,
  opts: {
    /** The holds to honour: `HOLDS`, which tests replace. */
    holds: readonly Hold[];
    /** `YYYY-MM-DD` (`utcDay`): a hold whose `until` is before it is inert. */
    today: string;
    /**
     * Tools the caller is about to lock for the first time (the upgrade, when
     * `mise.toml` declares a tool the lock does not record yet): "no version
     * recorded" is not a problem for them. The check never passes this — a
     * pushed lock records every tool.
     */
    unlockedAllowed?: ReadonlySet<string>;
  },
): string[] {
  const problems = holdProblems(opts.holds, opts.today, HOLDS_FILE);
  const known = new Set(TOOLS.map((t) => t.name));
  for (const [tool, request] of requests) {
    if (!known.has(tool))
      problems.push(
        `mise.toml declares "${tool}", which plugins/toolchain/core does not list — add it to TOOLS with its version probe and smoke tests.`,
      );
    if (request !== "latest")
      problems.push(
        `mise.toml requests ${tool} "${request}". Every tool must request "latest": a pin or prefix stops upgrades silently. ` +
          "Express a minimum as the tool's `floor`, or skip a broken release with a `hold`, in plugins/toolchain/core.",
      );
  }
  for (const spec of TOOLS) {
    if (!requests.has(spec.name))
      problems.push(
        `plugins/toolchain/core lists "${spec.name}", but mise.toml does not declare it.`,
      );
  }
  for (const [tool] of requests) {
    const versions = locked.get(tool) ?? [];
    const version = versions[0];
    if (versions.length === 0 && opts.unlockedAllowed?.has(tool) === true)
      continue;
    if (versions.length !== 1 || version === undefined) {
      problems.push(
        versions.length === 0
          ? `mise.lock records no version for ${tool}.`
          : `mise.lock records ${versions.length} versions for ${tool} (${versions.join(", ")}); it must record exactly one.`,
      );
      continue;
    }
    if (!isExactRelease(version)) {
      problems.push(
        `mise.lock records ${tool} "${version}", which is not an exact release.`,
      );
      continue;
    }
    const floor = TOOLS.find((t) => t.name === tool)?.floor;
    if (floor !== undefined && compareVersions(version, floor.version) < 0)
      problems.push(
        `mise.lock records ${tool} ${version}, below its floor ${floor.version}: ${floor.reason}`,
      );
    const hold = heldBy(opts.holds, tool, version, opts.today, compareVersions);
    if (hold !== undefined)
      problems.push(
        `mise.lock records ${tool} ${version}, which is held until ${hold.until}: ${hold.reason}${hold.issue === undefined ? "" : ` (${hold.issue})`}`,
      );
  }
  for (const [tool] of locked) {
    if (!requests.has(tool))
      problems.push(
        `mise.lock records ${tool}, which mise.toml does not declare.`,
      );
  }
  return problems;
}

/**
 * The release an upgrade should move `tool` to: the newest exact release in
 * `available` that no hold honoured on `today` covers. `null` when every
 * release is held.
 */
export function upgradeTarget(
  tool: string,
  available: readonly string[],
  holds: readonly Hold[],
  today: string,
): string | null {
  const candidates = available
    .filter(isExactRelease)
    .filter((v) => heldBy(holds, tool, v, today, compareVersions) === undefined)
    .sort(compareVersions);
  return candidates.at(-1) ?? null;
}
