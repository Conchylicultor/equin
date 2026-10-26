import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  heldBy,
  heldWaiting,
  utcDay,
  type Hold,
  type Move,
  type Outdated,
  type Updater,
  type UpdaterSmoke,
} from "@plugins/infra/plugins/deps/plugins/updates/core";
import {
  CARGO_HOLDS,
  CARGO_HOLDS_FILE,
} from "@plugins/infra/plugins/deps/plugins/rust/plugins/cargo-updater/core";
import {
  cargoCommand,
  cargoEnv,
  crateTargetDir,
} from "@plugins/infra/plugins/deps/plugins/rust/deps";

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a release must have been public before the updater adopts it. The
 * cheapest defence against a hijacked fresh release, while still landing
 * security fixes within days.
 */
export const CARGO_COOLDOWN_DAYS = 3;

/** The registry every move is checked against (publish day, yanked). */
const CRATES_IO_SOURCE =
  "registry+https://github.com/rust-lang/crates.io-index";

/** The newest publish instant a move may adopt: start of today (UTC) minus the cooldown. */
export function cargoCutoff(now: Date): string {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return new Date(today - CARGO_COOLDOWN_DAYS * DAY_MS).toISOString();
}

/** One crate, found by its tracked `rust/Cargo.lock`. */
interface Crate {
  /** Repo-relative crate dir, e.g. `plugins/menu-bar/rust`. */
  dir: string;
  /** The owning plugin's folder name — the prefix of a move's name. */
  label: string;
}

/** Every `rust/` crate in the checkout with a lock (tracked, or new and not ignored). */
export async function cargoCrates(root: string): Promise<Crate[]> {
  const result = await spawnCaptured(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ":(glob)plugins/**/rust/Cargo.lock",
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

/** `Updating serde v1.0.200 -> v1.0.210` lines of a `cargo update --dry-run`. */
export function parseCargoUpdates(
  output: string,
): Array<{ pkg: string; from: string; to: string }> {
  const out: Array<{ pkg: string; from: string; to: string }> = [];
  for (const line of output.split("\n")) {
    const m = /^Updating (\S+) v(\S+) -> v(\S+)/.exec(line.trim());
    if (m !== null) out.push({ pkg: m[1]!, from: m[2]!, to: m[3]! });
  }
  return out;
}

/** Every `[[package]]` of a `Cargo.lock`: name, version and source (absent for a path crate). */
export function parseCargoLock(
  text: string,
): Array<{ name: string; version: string; source: string | undefined }> {
  const out: Array<{
    name: string;
    version: string;
    source: string | undefined;
  }> = [];
  for (const block of text.split(/^\[\[package\]\]$/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    const source = /^source = "([^"]+)"/m.exec(block)?.[1];
    if (name === undefined || version === undefined) {
      throw new Error(
        `a Cargo.lock [[package]] without a name or version:\n${block}`,
      );
    }
    out.push({ name, version, source });
  }
  return out;
}

/** A release of one crate, as crates.io lists it. */
export interface CrateRelease {
  num: string;
  createdAt: string;
  yanked: boolean;
}

/**
 * The order releases are compared by: their dotted numbers, negative when `a`
 * is older. Pre-releases are never candidates, so their suffix is not ordered.
 */
export function compareCrateVersions(a: string, b: string): number {
  const nums = (v: string) =>
    (/^\d+(?:\.\d+)*/.exec(v)?.[0] ?? "").split(".").map(Number);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p - q;
  }
  return 0;
}

/**
 * The release to move a crate to: the newest one above `from` and at most
 * `ceiling` (the newest the Cargo.toml requirement allows, as cargo's dry run
 * reports it — every release between is in range too), published on or before
 * `cutoff`, not yanked, not a pre-release, and not covered by `holds`. `null`
 * when none qualifies. Pass no holds for the newest release outright.
 */
export function pickRelease(
  releases: readonly CrateRelease[],
  pkg: string,
  from: string,
  ceiling: string,
  cutoff: string,
  holds: readonly Hold[],
): string | null {
  let best: string | null = null;
  for (const r of releases) {
    if (r.yanked || r.num.includes("-") || r.num.includes("+")) continue;
    if (r.createdAt > cutoff) continue;
    if (compareCrateVersions(r.num, from) <= 0) continue;
    if (compareCrateVersions(r.num, ceiling) > 0) continue;
    if (heldBy(holds, pkg, r.num, compareCrateVersions)) continue;
    if (best === null || compareCrateVersions(r.num, best) > 0) best = r.num;
  }
  return best;
}

const versionsPage = z.object({
  versions: z.array(
    z.object({ num: z.string(), created_at: z.string(), yanked: z.boolean() }),
  ),
  meta: z.object({ next_page: z.string().nullable().optional() }),
});

/** Every release of `pkg` on crates.io, with its publish instant. */
async function crateReleases(pkg: string): Promise<CrateRelease[]> {
  const out: CrateRelease[] = [];
  let url: string | null =
    `https://crates.io/api/v1/crates/${encodeURIComponent(pkg)}/versions?per_page=100`;
  while (url !== null) {
    const res = await fetch(url, {
      // crates.io refuses requests without an identifying User-Agent.
      headers: { "User-Agent": "equin-deps-cargo-updater" },
      signal: AbortSignal.timeout(MINUTE),
    });
    if (!res.ok) {
      throw new Error(`crates.io ${url} answered ${res.status}`);
    }
    const page = versionsPage.parse(await res.json());
    for (const v of page.versions) {
      out.push({
        num: v.num,
        createdAt: new Date(v.created_at).toISOString(),
        yanked: v.yanked,
      });
    }
    const next = page.meta.next_page ?? null;
    url =
      next === null
        ? null
        : new URL(next, `https://crates.io/api/v1/crates/${pkg}/versions`).href;
  }
  return out;
}

async function cargo(
  root: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  const { argv, env } = cargoCommand(args);
  const result = await spawnCaptured(argv, {
    cwd: root,
    env,
    mergeStderr: true,
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${argv.join(" ")}\` failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}):\n${result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

const manifest = (root: string, crate: Crate): string =>
  join(root, crate.dir, "Cargo.toml");

/**
 * A move's name: `<plugin>:<crate>`, or `<plugin>:<crate>@<from>` when the
 * lock holds more than one release of it (two semver majors side by side).
 */
function moveName(
  crate: Crate,
  pkg: string,
  from: string,
  dup: boolean,
): string {
  return dup ? `${crate.label}:${pkg}@${from}` : `${crate.label}:${pkg}`;
}

/** The crate name a move's name carries: `menu-bar:serde@1.0.1` → `serde`. */
export function moveCrate(name: string): string {
  const pkg = name.slice(name.indexOf(":") + 1);
  const at = pkg.indexOf("@");
  return at === -1 ? pkg : pkg.slice(0, at);
}

/** One detected row with the lock entry it moves. */
interface CrateRow {
  outdated: Outdated;
  pkg: string;
  from: string;
}

/** What one crate's lock could move to, every row with its `from`. */
async function detectCrate(
  root: string,
  crate: Crate,
  cutoff: string,
  today: string,
): Promise<CrateRow[]> {
  const lock = parseCargoLock(
    readFileSync(join(root, crate.dir, "Cargo.lock"), "utf8"),
  );
  const fromCratesIo = new Set(
    lock
      .filter((p) => p.source === CRATES_IO_SOURCE)
      .map((p) => `${p.name}@${p.version}`),
  );
  const count = new Map<string, number>();
  for (const p of lock) count.set(p.name, (count.get(p.name) ?? 0) + 1);

  const output = await cargo(
    root,
    ["update", "--dry-run", "--manifest-path", manifest(root, crate)],
    10 * MINUTE,
  );
  const out: CrateRow[] = [];
  for (const u of parseCargoUpdates(output)) {
    // A git or path dependency has no publish day to cool down on: it moves
    // with its own pin, by hand.
    if (!fromCratesIo.has(`${u.pkg}@${u.from}`)) continue;
    if (compareCrateVersions(u.to, u.from) <= 0) continue;
    const releases = await crateReleases(u.pkg);
    const name = moveName(crate, u.pkg, u.from, (count.get(u.pkg) ?? 0) > 1);
    const target = pickRelease(
      releases,
      u.pkg,
      u.from,
      u.to,
      cutoff,
      CARGO_HOLDS,
    );
    const newest = pickRelease(releases, u.pkg, u.from, u.to, cutoff, []);
    if (target !== null) {
      out.push({
        outdated: { name, current: u.from, latest: target },
        pkg: u.pkg,
        from: u.from,
      });
    } else if (newest !== null) {
      // Nothing to move to but a held release: listed, so a hold is never silent.
      const hold = heldBy(CARGO_HOLDS, u.pkg, newest, compareCrateVersions)!;
      out.push({
        outdated: {
          name,
          current: u.from,
          latest: newest,
          waiting: heldWaiting(hold, today),
        },
        pkg: u.pkg,
        from: u.from,
      });
    }
  }
  return out;
}

/** What `cargo update -p <pkg>@<from> --precise <to> --dry-run` answered for one row. */
export type CargoProbe =
  | {
      ok: true;
      touched: ReadonlyArray<{ pkg: string; from: string; to: string }>;
    }
  | { ok: false; error: string };

/** How one movable row lands: in a unit with the rows it drags, or not now. */
export type CargoRowFate =
  | { kind: "moves"; unit: string | undefined }
  | { kind: "blocked"; prerequisite: string };

/**
 * Group the movable rows of one lock by what cargo really moves. A `--precise`
 * move drags along every lock entry the new release requires (futures-util
 * pins its futures-* siblings exactly, cc 1.9 needs a newer find-msvc-tools),
 * so the moves a probe touches are one lockstep unit: landed apart, the first
 * would already have moved the others. A row is blocked — reported, never
 * moved — when cargo cannot make it from this lock at all (a dependent's
 * requirement still excludes it), when it drags an entry to a release no row
 * plans (one still in its cooldown, or held), or when its unit holds such a
 * row.
 */
export function cargoRowFates(
  rows: ReadonlyArray<{ name: string; pkg: string; from: string; to: string }>,
  probes: ReadonlyMap<string, CargoProbe>,
): Map<string, CargoRowFate> {
  const key = (pkg: string, from: string) => `${pkg}@${from}`;
  const byKey = new Map(rows.map((r) => [key(r.pkg, r.from), r]));
  const blocked = new Map<string, string>();
  const links = new Map<string, Set<string>>(
    rows.map((r) => [r.name, new Set<string>()]),
  );
  for (const r of rows) {
    const probe = probes.get(r.name);
    if (probe === undefined) throw new Error(`no cargo probe for ${r.name}`);
    if (!probe.ok) {
      blocked.set(
        r.name,
        `nothing to do now: cargo cannot move ${r.pkg} to ${r.to} from this lock on its own (${probe.error}); it moves once what requires it does, retried by the next upgrade`,
      );
      continue;
    }
    for (const t of probe.touched) {
      if (t.pkg === r.pkg && t.from === r.from) continue;
      const other = byKey.get(key(t.pkg, t.from));
      if (other === undefined || other.to !== t.to) {
        blocked.set(
          r.name,
          `nothing to do now: moving ${r.pkg} to ${r.to} also moves ${t.pkg} ${t.from} → ${t.to}, which this upgrade does not plan (in its cooldown or held); retried by the next upgrade`,
        );
        continue;
      }
      links.get(r.name)!.add(other.name);
      links.get(other.name)!.add(r.name);
    }
  }
  // Connected components of the drag graph are the units.
  const fates = new Map<string, CargoRowFate>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.name)) continue;
    const members: string[] = [];
    const stack = [r.name];
    seen.add(r.name);
    while (stack.length > 0) {
      const n = stack.pop()!;
      members.push(n);
      for (const m of links.get(n)!) {
        if (!seen.has(m)) {
          seen.add(m);
          stack.push(m);
        }
      }
    }
    members.sort();
    const stuck = members.find((m) => blocked.has(m));
    for (const m of members) {
      if (stuck !== undefined) {
        fates.set(m, {
          kind: "blocked",
          prerequisite:
            m === stuck
              ? blocked.get(m)!
              : `moves together with ${members.filter((x) => x !== m).join(", ")}; ${stuck}: ${blocked.get(stuck)!}`,
        });
      } else {
        fates.set(m, {
          kind: "moves",
          unit: members.length > 1 ? members[0] : undefined,
        });
      }
    }
  }
  return fates;
}

/** A crate's rows with each movable one probed: blocked rows marked, units set. */
async function analyzeCrate(
  root: string,
  crate: Crate,
  cutoff: string,
  today: string,
): Promise<Array<{ outdated: Outdated; unit: string | undefined }>> {
  const rows = await detectCrate(root, crate, cutoff, today);
  const movable = rows.filter((r) => r.outdated.waiting === undefined);
  const probes = new Map<string, CargoProbe>();
  for (const r of movable) {
    // Offline: detection's own dry run just refreshed the index for every
    // crate of this graph.
    const { argv, env } = cargoCommand([
      "update",
      "--dry-run",
      "--offline",
      "--manifest-path",
      manifest(root, crate),
      "-p",
      `${r.pkg}@${r.from}`,
      "--precise",
      r.outdated.latest,
    ]);
    const result = await spawnCaptured(argv, {
      cwd: root,
      env,
      mergeStderr: true,
      timeoutMs: 10 * MINUTE,
    });
    if (result.timedOut) {
      throw new Error(`\`${argv.join(" ")}\` timed out`);
    }
    probes.set(
      r.outdated.name,
      result.exitCode === 0
        ? { ok: true, touched: parseCargoUpdates(result.stdout) }
        : {
            ok: false,
            error:
              result.stdout
                .split("\n")
                .find((l) => l.startsWith("error:"))
                ?.replace(/^error:\s*/, "") ??
              `exit ${result.exitCode}: ${result.stdout.trim()}`,
          },
    );
  }
  const fates = cargoRowFates(
    movable.map((r) => ({
      name: r.outdated.name,
      pkg: r.pkg,
      from: r.from,
      to: r.outdated.latest,
    })),
    probes,
  );
  return rows.map((r) => {
    const fate = fates.get(r.outdated.name);
    if (fate === undefined) return { outdated: r.outdated, unit: undefined };
    if (fate.kind === "blocked") {
      return {
        outdated: {
          ...r.outdated,
          waiting: { kind: "blocked", prerequisite: fate.prerequisite },
        },
        unit: undefined,
      };
    }
    return { outdated: r.outdated, unit: fate.unit };
  });
}

/** Every crate's analyzed rows, under one cooldown cutoff. */
async function analyze(
  root: string,
): Promise<Array<{ outdated: Outdated; unit: string | undefined }>> {
  const now = new Date();
  const cutoff = cargoCutoff(now);
  const today = utcDay(now);
  const out: Array<{ outdated: Outdated; unit: string | undefined }> = [];
  for (const crate of await cargoCrates(root)) {
    out.push(...(await analyzeCrate(root, crate, cutoff, today)));
  }
  return out;
}

/**
 * Every `rust/` crate's `Cargo.lock`, under one {@link CARGO_COOLDOWN_DAYS}-day
 * release cooldown. Detection asks cargo what each lock could move to within
 * its `Cargo.toml` requirements (`cargo update --dry-run`), then crates.io when
 * each candidate release was published, then probes each candidate on its own
 * ({@link cargoRowFates}: lockstep units, blocked rows); a move is one crate
 * pinned to the exact release planned (`cargo update -p <crate>@<from>
 * --precise <to>`), and the apply proves the lock holds exactly the plan. Requirements themselves
 * (`Cargo.toml`) are not moved: a new semver major is a code change.
 */
export const cargoUpdater: Updater = {
  id: "cargo",
  description: `Every rust/ crate's Cargo.lock (crates.io, ${CARGO_COOLDOWN_DAYS}-day release cooldown)`,

  files: async (root) =>
    (await cargoCrates(root)).map((c) => join(c.dir, "Cargo.lock")),

  async detect(root): Promise<Outdated[]> {
    return (await analyze(root)).map((r) => r.outdated);
  },

  async plan(root, only): Promise<Move[]> {
    const rows = await analyze(root);
    const outdated = rows.map((r) => r.outdated);
    if (only !== undefined) {
      const known = new Set(
        outdated.flatMap((o) => [o.name, moveCrate(o.name)]),
      );
      const unknown = only.filter((n) => !known.has(n));
      if (unknown.length > 0) {
        throw new Error(
          `Nothing to move named ${unknown.join(", ")}. Outdated now: ${outdated.map((o) => o.name).join(", ") || "none"}.`,
        );
      }
    }
    const picked = (name: string) =>
      only === undefined ||
      only.includes(name) ||
      only.includes(moveCrate(name));
    // A unit lands whole: naming one member with --only moves the unit.
    const units = new Set(
      rows
        .filter((r) => r.unit !== undefined && picked(r.outdated.name))
        .map((r) => r.unit),
    );
    return rows
      .filter((r) => r.outdated.waiting === undefined)
      .filter(
        (r) =>
          picked(r.outdated.name) ||
          (r.unit !== undefined && units.has(r.unit)),
      )
      .map((r) => ({
        name: r.outdated.name,
        from: r.outdated.current,
        to: r.outdated.latest,
        ...(r.unit !== undefined ? { unit: r.unit } : {}),
      }));
  },

  // Nothing to undo: `apply` only rewrites `Cargo.lock`, and every build is
  // installed under the identity the crate's files (lock included) hash to.
  sync: async () => {},

  async apply(root, moves, log) {
    for (const crate of await cargoCrates(root)) {
      const mine = moves.filter((m) => m.name.startsWith(`${crate.label}:`));
      if (mine.length === 0) continue;
      const lockPath = join(root, crate.dir, "Cargo.lock");
      const before = parseCargoLock(readFileSync(lockPath, "utf8"));
      for (const m of mine) {
        if (m.from === null) {
          throw new Error(`cargo move ${m.name} has no current release`);
        }
        const pkg = moveCrate(m.name);
        const now = parseCargoLock(readFileSync(lockPath, "utf8"));
        const has = (v: string) =>
          now.some((p) => p.name === pkg && p.version === v);
        if (has(m.to) && !has(m.from)) {
          // An earlier move of its unit already dragged it there.
          log(`  cargo ${crate.dir} ${pkg} ${m.to}: moved with its unit`);
          continue;
        }
        log(`  cargo update ${crate.dir} ${pkg} ${m.from} → ${m.to}`);
        await cargo(
          root,
          [
            "update",
            "--manifest-path",
            manifest(root, crate),
            "-p",
            `${pkg}@${m.from}`,
            "--precise",
            m.to,
          ],
          10 * MINUTE,
        );
        const locked = parseCargoLock(readFileSync(lockPath, "utf8"));
        if (!locked.some((p) => p.name === pkg && p.version === m.to)) {
          throw new Error(
            `\`cargo update --precise\` did not record ${pkg} ${m.to} in ${crate.dir}/Cargo.lock.`,
          );
        }
      }
      // Every entry the lock lost is a planned move's `from`: an entry cargo
      // dragged off its release without a move naming it would land
      // unreviewed. An entry ADDED beside the old ones (a new dependency of a
      // moved release, or a second semver major of one) is not a move.
      const after = new Set(
        parseCargoLock(readFileSync(lockPath, "utf8")).map(
          (p) => `${p.name}@${p.version}`,
        ),
      );
      const unplanned = before.filter(
        (p) =>
          p.source === CRATES_IO_SOURCE &&
          !after.has(`${p.name}@${p.version}`) &&
          !mine.some(
            (m) => moveCrate(m.name) === p.name && m.from === p.version,
          ),
      );
      if (unplanned.length > 0) {
        throw new Error(
          `the moves also moved ${unplanned.map((p) => `${p.name} ${p.version}`).join(", ")} in ${crate.dir}/Cargo.lock, which no planned move names.`,
        );
      }
    }
  },

  // The moved lock must still compile: `cargo check --locked` of each touched
  // crate, into its own dir of the shared target cache.
  async smoke(root, moves): Promise<UpdaterSmoke[]> {
    return (await cargoCrates(root))
      .filter((c) => moves.some((m) => m.name.startsWith(`${c.label}:`)))
      .map((c) => {
        const { argv } = cargoCommand([
          "check",
          "--locked",
          "--manifest-path",
          join(c.dir, "Cargo.toml"),
        ]);
        const env = cargoEnv({ targetDir: crateTargetDir(c.dir) });
        return {
          name: `cargo check (${c.label})`,
          argv,
          env: {
            PATH: env.PATH ?? "",
            CARGO_TARGET_DIR: env.CARGO_TARGET_DIR ?? "",
          },
          timeoutMs: 45 * MINUTE,
        };
      });
  },

  holds: {
    file: CARGO_HOLDS_FILE,
    read: async () => CARGO_HOLDS,
  },
};
