import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  HOLDS,
  TOOLS,
  addLockedTool,
  isExactRelease,
  lockProblems,
  parseMiseLock,
  parseMiseToolRequests,
  setLockedVersion,
  upgradeTarget,
} from "@plugins/toolchain/core";
import type {
  Move,
  Outdated,
  Updater,
} from "@plugins/infra/plugins/deps/plugins/updates/core";
import { mise } from "./mise";

const MINUTE = 60_000;

/** One entry of `mise outdated --json`. */
const OutdatedSchema = z.record(
  z.string(),
  z.object({ current: z.string().nullable(), latest: z.string() }),
);

/**
 * `mise version --json`: the running mise and the newest release it knows of.
 * `latest` is required — a mise that cannot say (offline, version checks off)
 * fails the detection loudly rather than reading as up to date.
 */
const MiseVersionSchema = z.object({ version: z.string(), latest: z.string() });

function miseVersion(output: string): string {
  return output.trim().split(/\s+/)[0] ?? "";
}

function readRequests(root: string): Map<string, string> {
  return parseMiseToolRequests(readFileSync(join(root, "mise.toml"), "utf8"));
}

/** Tools `mise.toml` declares that the lock does not record yet: first locks. */
function newlyDeclared(
  root: string,
  locked: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  return new Set(
    [...readRequests(root).keys()].filter(
      (tool) =>
        TOOLS.some((t) => t.name === tool) &&
        (locked.get(tool)?.length ?? 0) === 0,
    ),
  );
}

/**
 * `mise.toml` + `mise.lock` as the upgrade may start from: sound, except that a
 * tool `mise.toml` has just started declaring may have no lock entry yet (the
 * upgrade records its first one). Throws naming every problem.
 */
function assertSound(root: string): {
  locked: Map<string, string[]>;
  fresh: Set<string>;
} {
  const locked = parseMiseLock(readFileSync(join(root, "mise.lock"), "utf8"));
  const fresh = newlyDeclared(root, locked);
  const problems = lockProblems(readRequests(root), locked, {
    unlockedAllowed: fresh,
  });
  if (problems.length > 0) {
    throw new Error(
      `mise.toml / mise.lock are not sound; fix them first (\`./singularity check toolchain:resolved\`):\n  ${problems.join("\n  ")}`,
    );
  }
  return { locked, fresh };
}

/**
 * The mise toolchain (bun, go, tmux, rust, uv) as an updater: moves
 * `mise.lock` to the newest non-held release of each tool. This is the logic
 * `plugins/toolchain` ran as `toolchain upgrade`, moved onto the generic runner
 * (`toolchain upgrade` stays, as an alias). Declared tools, floors, holds and
 * the lock parsing stay in `plugins/toolchain/core`, which the
 * `toolchain:resolved` check reads too.
 */
export const miseUpdater: Updater = {
  id: "mise",
  description:
    "The mise toolchain (bun, go, tmux, rust, uv): mise.lock, one exact release per tool",
  files: async () => ["mise.lock"],

  // mise itself is part of the toolchain: an old mise resolves, installs and
  // locks with old bugs. It has no lock entry, so it simply moves to latest.
  async prepare(root, log) {
    // Soundness first, as before the move onto the runner: a broken pair is
    // refused before mise touches anything.
    assertSound(root);
    const before = miseVersion(await mise(root, ["--version"], MINUTE));
    log("Updating mise itself…");
    await mise(root, ["self-update", "--yes"], 10 * MINUTE);
    const after = miseVersion(await mise(root, ["--version"], MINUTE));
    log(`  mise ${before} → ${after}`);
    return { miseBefore: before, miseAfter: after };
  },

  // A held latest release is not "outdated": there is nothing newer to move
  // to past it until upstream ships again.
  //
  // mise itself is reported too. It has no lock entry, so no tool move ever
  // says it is behind — and `prepare` (its self-update) only runs inside an
  // upgrade a tool move started. Without this row a new mise reached the
  // machine only when Bun or Go happened to ship the same week.
  async detect(root): Promise<Outdated[]> {
    const self = MiseVersionSchema.parse(
      JSON.parse(await mise(root, ["version", "--json"], MINUTE)),
    );
    const running = miseVersion(self.version);
    const miseRow: Outdated[] =
      isExactRelease(self.latest) && self.latest !== running
        ? [{ name: "mise", current: running, latest: self.latest }]
        : [];
    const raw = await mise(root, ["outdated", "--json"], 5 * MINUTE);
    return miseRow.concat(
      Object.entries(OutdatedSchema.parse(JSON.parse(raw)))
        .filter(([tool]) => TOOLS.some((t) => t.name === tool))
        .filter(([, o]) => isExactRelease(o.latest))
        .filter(
          ([tool, o]) =>
            !HOLDS.some((h) => h.tool === tool && h.version === o.latest),
        )
        .map(([tool, o]) => ({
          name: tool,
          current: o.current,
          latest: o.latest,
        })),
    );
  },

  async plan(root, only): Promise<Move[]> {
    const unknown = only?.filter((t) => !TOOLS.some((s) => s.name === t)) ?? [];
    if (unknown.length > 0) {
      throw new Error(
        `Unknown tool ${unknown.join(", ")}. Tools: ${TOOLS.map((t) => t.name).join(", ")}.`,
      );
    }
    const { locked, fresh } = assertSound(root);
    const moves: Move[] = [];
    for (const spec of TOOLS) {
      if (only !== undefined && !only.includes(spec.name)) continue;
      const from = fresh.has(spec.name)
        ? null
        : (locked.get(spec.name)?.[0] ?? null);
      const available = (await mise(root, ["ls-remote", spec.name], 5 * MINUTE))
        .split("\n")
        .map((l) => l.trim());
      const to = upgradeTarget(spec.name, available);
      if (to === null)
        throw new Error(
          `mise lists no usable release of ${spec.name} (every exact release is held, or ls-remote returned none).`,
        );
      if (to !== from) moves.push({ name: spec.name, from, to });
    }
    return moves;
  },

  // Install side by side (nothing is uninstalled: main and every other
  // worktree keep running their own locked releases), then record them.
  async apply(root, moves, log) {
    const lockPath = join(root, "mise.lock");
    let nextLock = readFileSync(lockPath, "utf8");
    for (const { name, from, to } of moves) {
      log(`  installing ${name}@${to}`);
      await mise(root, ["install", `${name}@${to}`], 30 * MINUTE);
      nextLock =
        from === null
          ? addLockedTool(
              nextLock,
              name,
              to,
              (await mise(root, ["tool", name, "--backend"], MINUTE)).trim(),
            )
          : setLockedVersion(nextLock, name, to);
    }
    writeFileSync(lockPath, nextLock);
    await mise(root, ["lock"], 10 * MINUTE);
    const relocked = parseMiseLock(readFileSync(lockPath, "utf8"));
    for (const { name, to } of moves) {
      const got = relocked.get(name);
      if (got?.length !== 1 || got[0] !== to)
        throw new Error(
          `\`mise lock\` recorded ${name} as ${JSON.stringify(got)} instead of ${to}.`,
        );
    }
  },

  // Nothing to undo: `apply` installs side by side and the shims read
  // `mise.lock`, which the runner has already put back.
  sync: async () => {},

  smoke: async (_root, moves) =>
    TOOLS.filter((t) => moves.some((m) => m.name === t.name)).flatMap(
      (t) => t.smoke,
    ),

  holds: {
    file: "plugins/toolchain/core/internal/tools.ts",
  },
};
