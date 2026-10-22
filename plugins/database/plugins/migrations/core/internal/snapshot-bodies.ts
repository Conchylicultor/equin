/**
 * Snapshot BODIES by id — the one place a historical drizzle snapshot is read
 * (research/2026-10-22-global-single-live-migration-snapshot.md §6).
 *
 * Only the DAG's tip is on disk (`meta/schema.snapshot.json`); every other
 * body is in git. A merge node's 3-way join (its tips and their nearest common
 * ancestor) and a reset's lineage proofs ask for them here, and the resolver
 * tries, in order:
 *
 * 1. what this resolver already read or was handed (`remember`) — a body the
 *    generator is about to overwrite stays answerable;
 * 2. `meta/schema.snapshot.json` in the working tree, when its id matches;
 * 3. a pre-cutover `meta/<tag>_snapshot.json` in the working tree;
 * 4. for a MERGE NODE, recomputed from its parents (`./merge-node`): its body
 *    is a pure function of theirs, so it never has to have been committed —
 *    a push carrying a merge node and a schema migration on top of it commits
 *    only the latter's body;
 * 5. git: for an ordinary header node, `schema.snapshot.json` at the commit that added
 *    its `.sql` (else the commit that introduced the id into that file); for a
 *    legacy node, its `<tag>_snapshot.json` at the commit that added it.
 *
 * Every answer is checked against the id asked for. Anything that cannot be
 * answered throws, naming the id and what to do (a shallow clone has to fetch
 * its history) — a missing body is never stood in for.
 */
import { existsSync, readFileSync } from "fs";
import { join, relative } from "path";
import {
  spawnCaptured,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import { foldMergeParents, mergeNodeSnapshotText } from "./merge-node";
import {
  analyzeSnapshotDag,
  readSnapshotNodes,
  type SnapshotNode,
} from "./snapshot-dag";
import {
  legacySnapshotFileOf,
  parseSnapshotHead,
  SCHEMA_SNAPSHOT_FILE,
  schemaSnapshotPath,
} from "./schema-snapshot";
import type { Snapshot } from "./snapshot-merge";

/** A drizzle snapshot, parsed. */
export type SnapshotBody = Record<string, unknown>;

/** Resolves snapshot bodies by id; one instance per generate run (it caches). */
export interface SnapshotBodies {
  /** The exact text of snapshot `id` (byte-identical to what was committed). */
  text(id: string): Promise<string>;
  /** Snapshot `id`, parsed. */
  body(id: string): Promise<SnapshotBody>;
  /** Hand the resolver a body it will answer `id` with from now on. */
  remember(id: string, text: string): void;
}

// Wedge-breaker for local git reads: far above what any of them takes.
const GIT_TIMEOUT_MS = 120_000;

/**
 * The resolver for the data dir `dataDir` of the git checkout at `root`.
 * Nothing is read until a body is asked for.
 */
export function snapshotBodies(root: string, dataDir: string): SnapshotBodies {
  const cache = new Map<string, string>();
  const dataRel = relative(root, dataDir);
  const repoPath = (rel: string) =>
    dataRel === "" ? rel : `${dataRel}/${rel}`;
  let additions: Promise<Map<string, string>> | null = null;

  const git = (args: string[]) =>
    spawnExpectOk(["git", ...args], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });

  // path → the newest commit that added it, for every path ever added under
  // data/: one history walk, read once per resolver.
  const addedIn = (): Promise<Map<string, string>> => {
    additions ??= git([
      "log",
      "--diff-filter=A",
      "--no-renames",
      "--format=%x01%H",
      "--name-only",
      "--",
      dataRel === "" ? "." : dataRel,
    ]).then(({ stdout }) => {
      const map = new Map<string, string>();
      let commit = "";
      for (const line of stdout.split("\n")) {
        if (line.startsWith("\x01")) commit = line.slice(1);
        else if (line !== "" && !map.has(line)) map.set(line, commit);
      }
      return map;
    });
    return additions;
  };

  const headId = (text: string, where: string) =>
    parseSnapshotHead(text.slice(0, 1024), where).id;

  // `<rev>:<path>`, or null when git has no such object at that rev.
  const show = async (rev: string, path: string): Promise<string | null> => {
    const r = await spawnCaptured(["git", "show", `${rev}:${path}`], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (r.timedOut) throw new Error(`git show ${rev}:${path} timed out`);
    return r.exitCode === 0 ? r.stdout : null;
  };

  const shallowHint = async (): Promise<string> => {
    const r = await git(["rev-parse", "--is-shallow-repository"]);
    return r.stdout.trim() === "true"
      ? " This clone is shallow: fetch its history (`git fetch --unshallow`) and re-run."
      : "";
  };

  const fromGit = async (node: SnapshotNode): Promise<string> => {
    const added = await addedIn();
    const tried: string[] = [];
    if (node.lineage === "legacy") {
      const path = repoPath(`meta/${legacySnapshotFileOf(node.file)}`);
      const commit = added.get(path);
      if (commit !== undefined) {
        const text = await show(commit, path);
        if (text !== null && headId(text, `${commit}:${path}`) === node.id)
          return text;
        tried.push(`${commit}:${path}`);
      } else tried.push(`(no commit adds ${path})`);
    } else {
      const tipPath = repoPath(`meta/${SCHEMA_SNAPSHOT_FILE}`);
      const sqlPath = repoPath(node.file);
      const commit = added.get(sqlPath);
      if (commit !== undefined) {
        const text = await show(commit, tipPath);
        if (text !== null && headId(text, `${commit}:${tipPath}`) === node.id)
          return text;
        tried.push(`${commit}:${tipPath}`);
      } else tried.push(`(no commit adds ${sqlPath})`);
      // The .sql landed apart from its body (a hand-split commit): the commit
      // that put the id at the top of the tip file.
      const pickaxe = await git([
        "log",
        "--format=%H",
        "--reverse",
        `-S"id": "${node.id}"`,
        "--",
        tipPath,
      ]);
      for (const c of pickaxe.stdout.split("\n").filter(Boolean)) {
        const text = await show(c, tipPath);
        if (text !== null && headId(text, `${c}:${tipPath}`) === node.id)
          return text;
        tried.push(`${c}:${tipPath}`);
      }
    }
    throw new Error(
      `no body for snapshot ${node.id} (${node.file}): it is not in the working tree, and git has it nowhere ` +
        `(tried ${tried.join(", ")}).${await shallowHint()} ` +
        "Report it — never hand-write a snapshot.",
    );
  };

  // Ids being recomputed right now: re-entering one is a cycle the DAG check
  // should have refused — fail rather than recurse forever.
  const computing = new Set<string>();
  const recomputeMerge = async (
    node: SnapshotNode,
    parents: readonly string[],
  ): Promise<string> => {
    if (computing.has(node.id))
      throw new Error(
        `snapshot ${node.id} (${node.file}) descends from itself; run \`./singularity check snapshot-chain-intact\``,
      );
    computing.add(node.id);
    try {
      const dag = analyzeSnapshotDag(await readSnapshotNodes(dataDir));
      const fold = await foldMergeParents(
        dag,
        parents,
        async (id) => JSON.parse(await text(id)) as Snapshot,
      );
      if (!fold.ok)
        throw new Error(
          `cannot recompute merge node ${node.file} (${node.id}) from its parents: ` +
            (fold.kind === "conflict"
              ? `${fold.conflicts.length} conflicting path(s) between ${fold.ours.join("+")} and ${fold.theirs}`
              : `${fold.nearest} nearest common ancestors between ${fold.ours.join("+")} and ${fold.theirs}`) +
            " — its parents' lineage changed since it was written. Report it; never hand-write a snapshot.",
        );
      return mergeNodeSnapshotText(node.id, parents, fold.merged);
    } finally {
      computing.delete(node.id);
    }
  };

  const text = async (id: string): Promise<string> => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;

    const tipPath = schemaSnapshotPath(dataDir);
    if (existsSync(tipPath)) {
      const tip = readFileSync(tipPath, "utf8");
      if (headId(tip, tipPath) === id) {
        cache.set(id, tip);
        return tip;
      }
    }
    // Read fresh each miss: the generator adds and deletes nodes as it runs.
    const node = (await readSnapshotNodes(dataDir)).find((n) => n.id === id);
    if (node === undefined)
      throw new Error(`snapshot ${id} is not a node of the snapshot DAG`);
    const legacyPath = join(dataDir, "meta", legacySnapshotFileOf(node.file));
    let found: string | null = null;
    if (existsSync(legacyPath)) {
      const legacy = readFileSync(legacyPath, "utf8");
      if (headId(legacy, legacyPath) === id) found = legacy;
    }
    found ??=
      node.mergeParents !== null
        ? await recomputeMerge(node, node.mergeParents)
        : await fromGit(node);
    cache.set(id, found);
    return found;
  };

  return {
    text,
    async body(id) {
      return JSON.parse(await text(id)) as SnapshotBody;
    },
    remember(id, t) {
      if (headId(t, `the snapshot handed for ${id}`) !== id)
        throw new Error(`remember(${id}) was handed another snapshot`);
      cache.set(id, t);
    },
  };
}
