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
 *    legacy node, its `<tag>_snapshot.json` at the commit that added it;
 * 6. for a header node, the tip file at each commit this checkout's HEAD
 *    reflog names (newest first): a rebase replays a branch-local migration's
 *    `.sql` but its merge driver keeps main's tip file, so the rebased history
 *    no longer holds the body — the pre-rebase commit, still in the reflog,
 *    does. Only the commits the reflog itself names are read (no history walk:
 *    a `--reflog` log over this repo's history takes minutes).
 *
 * Every answer is checked against the id asked for. Anything that cannot be
 * answered throws, naming the id and what to do (a shallow clone has to fetch
 * its history) — a missing body is never stood in for.
 */
import { relative } from "path";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
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
} from "./schema-snapshot";
import { diskMigrationData, type MigrationData } from "./migration-data";
import type { Snapshot } from "./snapshot-merge";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * No source holds snapshot `id`'s body: not the working tree, not git (an
 * ordinary header node whose `.sql` was never committed, while the tip file
 * is another snapshot's). A caller that can do without the body (a reset's
 * lineage proof, `reset-lineage.ts`) catches exactly this; every other
 * failure to read one stays a plain throw.
 */
export class MissingSnapshotBodyError extends Error {
  constructor(
    readonly id: string,
    readonly file: string,
    message: string,
  ) {
    super(message);
    this.name = "MissingSnapshotBodyError";
  }
}

/** A drizzle snapshot, parsed. */
export type SnapshotBody = Record<string, unknown>;

/** Resolves snapshot bodies by id; one instance per generate run (it caches). */
export interface SnapshotBodies {
  /**
   * The exact text of snapshot `id` (byte-identical to what was committed).
   * `node`: its DAG node, when the caller holds one the tree no longer does —
   * a migration an interrupted reset deleted, read back from HEAD.
   */
  text(id: string, node?: SnapshotNode): Promise<string>;
  /** Snapshot `id`, parsed. */
  body(id: string, node?: SnapshotNode): Promise<SnapshotBody>;
  /** Hand the resolver a body it will answer `id` with from now on. */
  remember(id: string, text: string): void;
}

// Wedge-breaker for local git reads: far above what any of them takes.
const GIT_TIMEOUT_MS = 120_000;

/**
 * The text of each git object `specs` names (`<rev>:<path>`), in order, read
 * with one `git cat-file --batch`; null for one git does not have. The batch
 * protocol frames each object as `<sha> <type> <size>\n<size bytes>\n`, or
 * `<spec> missing\n`, in request order.
 */
async function readBlobs(
  root: string,
  specs: readonly string[],
): Promise<(string | null)[]> {
  const argv = ["git", "cat-file", "--batch"];
  const r = await spawnCaptured(argv, {
    cwd: root,
    stdin: specs.map((spec) => `${spec}\n`).join(""),
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r.timedOut)
    throw new Error(`${argv.join(" ")} timed out (${specs.length} object(s))`);
  if (r.exitCode !== 0)
    throw new Error(
      `${argv.join(" ")} failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
    );
  const buf = r.stdoutBytes;
  const decoder = new TextDecoder();
  const out: (string | null)[] = [];
  let i = 0;
  for (const spec of specs) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0)
      throw new Error(`git cat-file --batch: output ends before ${spec}`);
    const header = decoder.decode(buf.subarray(i, nl));
    i = nl + 1;
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
      out.push(null);
      continue;
    }
    const size = Number.parseInt(header.split(" ")[2] ?? "", 10);
    if (!Number.isFinite(size) || i + size > buf.length)
      throw new Error(
        `git cat-file --batch: unreadable header "${header}" for ${spec}`,
      );
    out.push(decoder.decode(buf.subarray(i, i + size)));
    i += size + 1;
  }
  return out;
}

/**
 * The resolver for the data dir `dataDir` of the git checkout at `root`.
 * Nothing is read until a body is asked for.
 *
 * `files`: where the data dir's working-tree files are read — off disk by
 * default, or a check's recorded file set (`./migration-data`), so every
 * working-tree read the resolver makes is one the check's read-set holds.
 * Git paths are always `dataDir`'s.
 */
export function snapshotBodies(
  root: string,
  dataDir: AppPath,
  files: MigrationData = diskMigrationData(dataDir),
): SnapshotBodies {
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

  // `<rev>:<path>`, or null when git has no such object at that rev. Every
  // read asked for before the next macrotask goes into ONE `git cat-file
  // --batch`: a git start costs ~40 ms of CPU in this repo, and a body read
  // with the others shares git's delta-base cache (each tip file is a delta of
  // the last), so 72 bodies cost one start (~0.1 s), not 72 (~3 CPU-s).
  const pending: {
    spec: string;
    resolve: (text: string | null) => void;
    reject: (err: unknown) => void;
  }[] = [];
  const flush = (): void => {
    const batch = pending.splice(0);
    void readBlobs(
      root,
      batch.map((b) => b.spec),
    ).then(
      (texts) => batch.forEach((b, i) => b.resolve(texts[i]!)),
      (err: unknown) => batch.forEach((b) => b.reject(err)),
    );
  };
  const show = (rev: string, path: string): Promise<string | null> =>
    new Promise((resolve, reject) => {
      if (pending.length === 0) void yieldMacrotask().then(flush);
      pending.push({ spec: `${rev}:${path}`, resolve, reject });
    });

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
      // Rewritten away by a rebase (the merge driver kept main's tip file):
      // the pre-rewrite commit is still in this checkout's reflog.
      const reflog = await spawnCaptured(["git", "reflog", "--format=%H"], {
        cwd: root,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (reflog.timedOut) throw new Error("git reflog timed out");
      const seen = new Set<string>();
      for (const c of reflog.stdout.split("\n").filter(Boolean)) {
        if (seen.has(c)) continue;
        seen.add(c);
        const text = await show(c, tipPath);
        if (text !== null && headId(text, `${c}:${tipPath}`) === node.id)
          return text;
      }
      tried.push(`the tip file at ${seen.size} reflog commit(s)`);
    }
    throw new MissingSnapshotBodyError(
      node.id,
      node.file,
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
        `snapshot ${node.id} (${node.file}) descends from itself; run \`./equin check snapshot-chain-intact\``,
      );
    computing.add(node.id);
    try {
      const dag = analyzeSnapshotDag(await readSnapshotNodes(files));
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

  const text = async (id: string, known?: SnapshotNode): Promise<string> => {
    if (known !== undefined && known.id !== id)
      throw new Error(`text(${id}) was handed the node of ${known.id}`);
    const cached = cache.get(id);
    if (cached !== undefined) return cached;

    const tipRel = `meta/${SCHEMA_SNAPSHOT_FILE}`;
    // The head first: every body asked for reads it, and only one is the tip.
    const tipStart = await files.start(tipRel);
    if (tipStart !== null && headId(tipStart, tipRel) === id) {
      const tip = await files.text(tipRel);
      if (tip !== null && headId(tip, tipRel) === id) {
        cache.set(id, tip);
        return tip;
      }
    }
    // Read fresh each miss: the generator adds and deletes nodes as it runs.
    const node =
      known ?? (await readSnapshotNodes(files)).find((n) => n.id === id);
    if (node === undefined)
      throw new Error(`snapshot ${id} is not a node of the snapshot DAG`);
    const legacyRel = `meta/${legacySnapshotFileOf(node.file)}`;
    let found: string | null = null;
    const legacy = await files.text(legacyRel);
    if (legacy !== null && headId(legacy, legacyRel) === id) found = legacy;
    found ??=
      node.mergeParents !== null
        ? await recomputeMerge(node, node.mergeParents)
        : await fromGit(node);
    cache.set(id, found);
    return found;
  };

  return {
    text,
    async body(id, node) {
      return JSON.parse(await text(id, node)) as SnapshotBody;
    },
    remember(id, t) {
      if (headId(t, `the snapshot handed for ${id}`) !== id)
        throw new Error(`remember(${id}) was handed another snapshot`);
      cache.set(id, t);
    },
  };
}
