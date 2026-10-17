import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  heldBy,
  heldWaiting,
  isActionable,
  utcDay,
  type Hold,
  type Move,
  type Outdated,
  type Updater,
  type UpdaterSmoke,
} from "@plugins/infra/plugins/deps/plugins/updates/core";
import {
  UV_HOLDS,
  UV_HOLDS_FILE,
} from "@plugins/infra/plugins/deps/plugins/python/plugins/uv-updater/core";
import { uvEnv } from "@plugins/infra/plugins/deps/plugins/python/deps";

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a release must have been public before the updater adopts it. The
 * cheapest defence against a hijacked fresh release, while still landing
 * security fixes within days.
 */
export const UV_COOLDOWN_DAYS = 3;

/**
 * The newest upload a resolution may use: the start of today (UTC) minus the
 * cooldown. Day-granular, so a `plan` and the `apply` after it agree.
 */
export function uvCutoff(now: Date): string {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return new Date(today - UV_COOLDOWN_DAYS * DAY_MS).toISOString();
}

/** One uv project, found by its tracked `python/pyproject.toml`. */
interface UvProject {
  /** Repo-relative dir, e.g. `plugins/<…>/audio-analysis/python`. */
  dir: string;
  /** The owning plugin's folder name — the prefix of a move's name. */
  label: string;
}

/** Every `python/` project in the checkout (tracked, or new and not ignored). */
export async function uvProjects(root: string): Promise<UvProject[]> {
  const result = await spawnCaptured(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ":(glob)plugins/**/python/pyproject.toml",
    ],
    { cwd: root, timeoutMs: MINUTE },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((file) => {
      const dir = dirname(file);
      return { dir, label: basename(dirname(dir)) };
    });
}

/** `Update numpy v2.5.3 -> v2.5.4` lines of a `uv lock` run. */
export function parseLockUpdates(
  output: string,
): Array<{ pkg: string; from: string; to: string }> {
  const out: Array<{ pkg: string; from: string; to: string }> = [];
  for (const line of output.split("\n")) {
    const m = /^Update (\S+) v(\S+) -> v(\S+)$/.exec(line.trim());
    if (m !== null) out.push({ pkg: m[1]!, from: m[2]!, to: m[3]! });
  }
  return out;
}

/** Every `[[package]]`'s version in a `uv.lock`, by name. */
export function parseUvLockVersions(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  let name: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("[[package]]")) {
      name = null;
      continue;
    }
    const n = /^name = "([^"]+)"/.exec(line)?.[1];
    if (n !== undefined) {
      name = n;
      continue;
    }
    const v = /^version = "([^"]+)"/.exec(line)?.[1];
    if (v !== undefined && name !== null) versions.set(name, v);
  }
  return versions;
}

/**
 * The package name a move of a project's interpreter (`.python-version`)
 * carries: `audio-analysis:cpython`. A hold on it holds a CPython release.
 */
export const CPYTHON = "cpython";

/** A stable CPython build uv can download, and the day it was published. */
export interface CpythonDownload {
  version: string;
  /** `YYYY-MM-DD` of the python-build-standalone release carrying the build. */
  published: string;
}

const pythonListSchema = z.array(
  z.object({
    version: z.string(),
    implementation: z.string(),
    variant: z.string(),
    url: z.string().nullable(),
  }),
);

/**
 * The stable, default-variant CPython builds in a `uv python list
 * --only-downloads --output-format json`. Pre-releases (`3.15.0rc2`) and the
 * freethreaded/debug variants are never candidates. A build's publish day is
 * its python-build-standalone release tag (`…/download/20260924/…`); with
 * `--all-versions` each version is listed at the newest release that still
 * carries it, so the day is never earlier than the version's own — a
 * cooldown measured from it is conservative.
 */
export function parseCpythonDownloads(json: string): CpythonDownload[] {
  const out: CpythonDownload[] = [];
  for (const d of pythonListSchema.parse(JSON.parse(json))) {
    if (d.implementation !== "cpython" || d.variant !== "default") continue;
    if (!/^\d+\.\d+\.\d+$/.test(d.version) || d.url === null) continue;
    const day = /\/download\/(\d{4})(\d{2})(\d{2})\//.exec(d.url);
    if (day === null) {
      throw new Error(
        `CPython ${d.version}'s download URL carries no release day: ${d.url}`,
      );
    }
    out.push({
      version: d.version,
      published: `${day[1]}-${day[2]}-${day[3]}`,
    });
  }
  return out;
}

/**
 * The newest CPython published on or before `cutoff` (an ISO instant from
 * {@link uvCutoff}) that no hold in `holds` covers (lapsed or not), or `null`
 * when none is. Pass no holds for the newest release outright.
 */
export function newestCpython(
  downloads: readonly CpythonDownload[],
  cutoff: string,
  holds: readonly Hold[],
): string | null {
  let best: string | null = null;
  for (const d of downloads) {
    if (`${d.published}T00:00:00.000Z` > cutoff) continue;
    if (heldBy(holds, CPYTHON, d.version, compareReleases)) continue;
    if (best === null || isNewerRelease(d.version, best)) best = d.version;
  }
  return best;
}

/** Every CPython build this checkout's uv can download for this machine. */
async function cpythonDownloads(root: string): Promise<CpythonDownload[]> {
  const argv = [
    "uv",
    "python",
    "list",
    "--only-downloads",
    "--all-versions",
    "--output-format",
    "json",
  ];
  const result = await spawnCaptured(argv, {
    cwd: root,
    env: uvEnv(),
    timeoutMs: MINUTE,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${argv.join(" ")}\` failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${result.stderr.trim()}`,
    );
  }
  return parseCpythonDownloads(result.stdout);
}

const pythonVersionFile = (root: string, project: UvProject): string =>
  join(root, project.dir, ".python-version");

async function uvLock(
  root: string,
  project: UvProject,
  args: readonly string[],
): Promise<string> {
  const argv = ["uv", "lock", "--project", join(root, project.dir), ...args];
  const result = await spawnCaptured(argv, {
    cwd: root,
    env: uvEnv(),
    mergeStderr: true,
    timeoutMs: 10 * MINUTE,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${argv.join(" ")}\` failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}):\n${result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Whether `to` is a newer release than `from`, by their leading dotted
 * numbers. A resolution under a cutoff older than the lock's own can propose a
 * DOWNGRADE (same `Update` line); that is never an upgrade. Anything the
 * numbers cannot order counts as newer, so a move is never silently dropped;
 * equal numbers (a pre-release suffix aside) are not newer.
 */
export function isNewerRelease(to: string, from: string): boolean {
  return compareReleases(to, from) > 0;
}

/**
 * The order {@link isNewerRelease} and a `below` hold measure by: negative
 * when `a` is older. A version the numbers cannot order counts as newer.
 */
export function compareReleases(a: string, b: string): number {
  const nums = (v: string) =>
    (/^\d+(?:\.\d+)*/.exec(v)?.[0] ?? "")
      .split(".")
      .filter(Boolean)
      .map(Number);
  const x = nums(a);
  const y = nums(b);
  if (x.length === 0 || y.length === 0) return 1;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p - q;
  }
  return 0;
}

/** A move's name: `<plugin>:<package>`, e.g. `audio-analysis:numpy`. */
const moveName = (project: UvProject, pkg: string): string =>
  `${project.label}:${pkg}`;

/**
 * Every `python/` project's `uv.lock` and `.python-version`, under one
 * {@link UV_COOLDOWN_DAYS}-day release cooldown.
 *
 * - **Packages** move with `uv lock` under `exclude-newer`. Each move is one
 *   package, pinned to the exact version planned (`--upgrade-package
 *   name==version`), so the apply lands exactly what the plan named and a held
 *   release is never adopted.
 * - **The interpreter** (`<plugin>:cpython`) moves to the newest stable CPython
 *   the pinned uv can download that is past the cooldown, written as an exact
 *   version so the env's identity changes with it. A new minor (3.14 → 3.15) is
 *   an ordinary move: the gates decide whether it works.
 */
export const uvUpdater: Updater = {
  id: "uv",
  description: `Every python/ project's uv.lock and .python-version (${UV_COOLDOWN_DAYS}-day release cooldown)`,

  files: async (root) =>
    (await uvProjects(root)).flatMap((p) => [
      join(p.dir, "uv.lock"),
      join(p.dir, ".python-version"),
    ]),

  async detect(root): Promise<Outdated[]> {
    const now = new Date();
    const cutoff = uvCutoff(now);
    const today = utcDay(now);
    const downloads = await cpythonDownloads(root);
    const cpython = newestCpython(downloads, cutoff, UV_HOLDS);
    const newest = newestCpython(downloads, cutoff, []);
    const out: Outdated[] = [];
    for (const project of await uvProjects(root)) {
      const pinned = readFileSync(
        pythonVersionFile(root, project),
        "utf8",
      ).trim();
      if (cpython !== null && isNewerRelease(cpython, pinned)) {
        out.push({
          name: moveName(project, CPYTHON),
          current: pinned,
          latest: cpython,
        });
      } else if (newest !== null && isNewerRelease(newest, pinned)) {
        // Nothing to move to but a held release: listed, so a hold is never silent.
        const hold = heldBy(UV_HOLDS, CPYTHON, newest, compareReleases)!;
        out.push({
          name: moveName(project, CPYTHON),
          current: pinned,
          latest: newest,
          waiting: heldWaiting(hold, today),
        });
      }
      const output = await uvLock(root, project, [
        "--upgrade",
        "--dry-run",
        "--exclude-newer",
        cutoff,
      ]);
      for (const u of parseLockUpdates(output)) {
        if (!isNewerRelease(u.to, u.from)) continue;
        const hold = heldBy(UV_HOLDS, u.pkg, u.to, compareReleases);
        out.push({
          name: moveName(project, u.pkg),
          current: u.from,
          latest: u.to,
          ...(hold === undefined ? {} : { waiting: heldWaiting(hold, today) }),
        });
      }
    }
    return out;
  },

  async plan(root, only): Promise<Move[]> {
    const outdated = await uvUpdater.detect(root);
    if (only !== undefined) {
      const known = new Set(
        outdated.flatMap((o) => [o.name, o.name.split(":")[1] ?? o.name]),
      );
      const unknown = only.filter((n) => !known.has(n));
      if (unknown.length > 0) {
        throw new Error(
          `Nothing to move named ${unknown.join(", ")}. Outdated now: ${outdated.map((o) => o.name).join(", ") || "none"}.`,
        );
      }
    }
    return outdated
      .filter(isActionable)
      .filter(
        (o) =>
          only === undefined ||
          only.includes(o.name) ||
          only.includes(o.name.split(":")[1] ?? ""),
      )
      .map((o) => ({ name: o.name, from: o.current, to: o.latest }));
  },

  // Nothing to undo: `apply` only rewrites `uv.lock` / `.python-version`, and
  // every env is installed under the identity those files hash to.
  sync: async () => {},

  async apply(root, moves, log) {
    const cutoff = uvCutoff(new Date());
    for (const project of await uvProjects(root)) {
      const ours = moves.filter((m) => m.name.startsWith(`${project.label}:`));
      const interpreter = ours.find(
        (m) => m.name === moveName(project, CPYTHON),
      );
      if (interpreter !== undefined) {
        log(`  ${project.dir}/.python-version → ${interpreter.to}`);
        writeFileSync(pythonVersionFile(root, project), `${interpreter.to}\n`);
      }
      const mine = ours.filter((m) => m !== interpreter);
      if (mine.length === 0) continue;
      const pins = mine.flatMap((m) => [
        "--upgrade-package",
        `${m.name.slice(project.label.length + 1)}==${m.to}`,
      ]);
      log(`  uv lock ${project.dir} (${mine.map((m) => m.name).join(", ")})`);
      await uvLock(root, project, ["--exclude-newer", cutoff, ...pins]);
      const locked = parseUvLockVersions(
        readFileSync(join(root, project.dir, "uv.lock"), "utf8"),
      );
      for (const m of mine) {
        const pkg = m.name.slice(project.label.length + 1);
        if (locked.get(pkg) !== m.to) {
          throw new Error(
            `\`uv lock\` recorded ${pkg} as ${locked.get(pkg) ?? "(absent)"} instead of ${m.to} in ${project.dir}/uv.lock.`,
          );
        }
      }
    }
  },

  // The moved lock must still install: a throwaway `uv sync --frozen` of each
  // touched project, into a temp env removed afterwards.
  async smoke(root, moves): Promise<UpdaterSmoke[]> {
    const env = uvEnv();
    const cacheEnv = {
      UV_CACHE_DIR: env.UV_CACHE_DIR ?? "",
      UV_PYTHON_INSTALL_DIR: env.UV_PYTHON_INSTALL_DIR ?? "",
      UV_PYTHON_PREFERENCE: env.UV_PYTHON_PREFERENCE ?? "",
    };
    return (await uvProjects(root))
      .filter((p) => moves.some((m) => m.name.startsWith(`${p.label}:`)))
      .map((p) => ({
        name: `uv sync (${p.label})`,
        argv: [
          "sh",
          "-c",
          'd=$(mktemp -d) && UV_PROJECT_ENVIRONMENT="$d" uv sync --frozen --no-install-project --no-dev --project "$0"; s=$?; rm -rf "$d"; exit $s',
          p.dir,
        ],
        env: cacheEnv,
        timeoutMs: 30 * MINUTE,
      }));
  },

  holds: {
    file: UV_HOLDS_FILE,
    read: async () => UV_HOLDS,
  },
};
