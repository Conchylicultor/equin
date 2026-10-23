import { existsSync, statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  PROTOTYPE_ENTRY_FILE,
  protoIdKind,
  readPrototypeOptions,
} from "../../core";
import type {
  PrototypeHistory,
  PrototypeOption,
  PrototypeVersion,
} from "../../core";
import { listPrototypeDirNames } from "../read-folder";
import { historyGit, initBareRepo, type HistoryGit } from "./git";
import { withHistoryLock } from "./lock";
import {
  formatVersionMessage,
  parseVersionMessage,
  toSubjectLine,
  type VersionMessage,
} from "./message";

// The prototype version store: one private bare git repo per prototype, at
// `<prototypes>/_history/<id>.git`, whose work tree is the prototype folder.
//
// Beside the folder, not in it: a prototype is flat (the file route serves
// `<id>/<file>` and nothing deeper, `validatePrototypeFolder` flags a
// subdirectory), and a `.git` inside would churn the watcher's signature and the
// thumbnail fingerprint. `_history/` is `_`-prefixed, so every reader of the
// tree skips it the way it skips `_template/` — `listPrototypeDirNames`.
//
// Node-only and in `shared/` for the reason `mint.ts` is: the server records
// versions, and `./singularity prototype log|checkpoint|restore` reads and
// writes the same repos with no backend running.
//
// Design: `research/2026-09-11-apps-prototype-version-history.md`.

/** The history dir's name inside the prototypes data dir. */
export const HISTORY_DIR_NAME = "_history";

/**
 * The stamp written into a repo after every version it records: `{ n, sha }`
 * of the newest one. Git's own files carry no extension, so the watcher's
 * extension filter never passes them; this is the one history file it sees —
 * how a version recorded by ANOTHER backend reaches this one's subscribers.
 */
export const LATEST_STAMP_FILE = "latest.json";

/** The stamp's shape: the newest version's position and sha. */
const LatestStampSchema = z.object({
  n: z.number().int().nonnegative(),
  sha: z.string(),
});

/** What a recorded version carries beyond the wire shape — for `prototype log`. */
export interface VersionEntry extends PrototypeVersion {
  /** The commit body: a turn's request and agent summary. `""` when none. */
  body: string;
}

export type EnsureHistoryResult =
  { kind: "created" } | { kind: "exists" } | { kind: "no-such-prototype" };

export interface CheckpointInput {
  kind: "turn" | "manual";
  /** Free text; its first line becomes the subject (≤ 72 chars). */
  subject: string;
  body?: string;
  conversationId?: string;
  messageId?: string;
}

export type CheckpointResult =
  | { kind: "recorded"; version: PrototypeVersion }
  /** Nothing changed, OR a version already carries this `messageId`. */
  | { kind: "unchanged" }
  | { kind: "no-such-prototype" };

export type HistoryRead =
  | { kind: "history"; history: PrototypeHistory; entries: VersionEntry[] }
  | { kind: "no-such-prototype" };

export type VersionFileRead =
  { kind: "found"; bytes: Uint8Array<ArrayBuffer> } | { kind: "not-found" };

export type RestoreResult =
  | { kind: "restored"; version: PrototypeVersion }
  | { kind: "no-such-prototype" }
  | { kind: "unknown-version" };

export interface HistoryStore {
  /**
   * Give the prototype a history if it has none: `v0` is the folder as it is
   * now. Idempotent and race-safe — every backend adopts on boot, and a mint
   * does it for the prototype it just made.
   */
  ensureHistory(id: string): Promise<EnsureHistoryResult>;
  /** {@link ensureHistory} for every minted-id folder in the tree. */
  adoptAll(): Promise<void>;
  /** Record the folder as a new version, if it changed. */
  checkpoint(id: string, input: CheckpointInput): Promise<CheckpointResult>;
  /** Every version, oldest → newest, and whether the folder has moved since. */
  readHistory(id: string): Promise<HistoryRead>;
  /**
   * How many versions each prototype has, keyed by id — read from each repo's
   * `latest.json` stamp (`n + 1`), never from git: one small file read per
   * prototype, all in parallel, so the gallery's whole-list read stays cheap. A
   * repo without a stamp (or a prototype without a repo) is absent, never `0`;
   * a malformed stamp throws.
   */
  readVersionCounts(): Promise<Record<string, number>>;
  /** One file of one version, as bytes. */
  readVersionFile(
    id: string,
    sha: string,
    file: string,
  ): Promise<VersionFileRead>;
  /** The diff a version made (`git show` style); the whole tree for `v0`. */
  readVersionPatch(id: string, sha: string): Promise<string>;
  /**
   * Make version `sha` live again: unsaved changes are recorded first (a
   * `manual` "Before restore" version), the old files are written back — and
   * files it did not have are deleted — then a `restore` version records it.
   */
  restoreVersion(id: string, sha: string): Promise<RestoreResult>;
}

/**
 * The store over the prototypes tree at `root`. The CALLER resolves the root
 * (`prototypesDir.path`, per call — the data root is env-overridable), which is
 * also what lets the tests run it against a temp dir.
 */
export function openHistoryStore(root: string): HistoryStore {
  const historyDir = join(root, HISTORY_DIR_NAME);
  // Each path helper validates the id itself, so no path is built from one
  // that is not a minted id.
  const folderOf = (id: string): string => join(root, assertPrototypeId(id));
  const repoOf = (id: string): string =>
    join(historyDir, `${assertPrototypeId(id)}.git`);
  const lockOf = (id: string): string =>
    join(historyDir, `${assertPrototypeId(id)}.lock`);
  const gitOf = (id: string): HistoryGit =>
    historyGit(repoOf(id), folderOf(id));

  async function ensureHistory(id: string): Promise<EnsureHistoryResult> {
    if (!isDirectory(folderOf(id))) return { kind: "no-such-prototype" };
    if (existsSync(repoOf(id))) return { kind: "exists" };

    await mkdir(historyDir, { recursive: true });
    return withHistoryLock(lockOf(id), async () => {
      if (existsSync(repoOf(id))) return { kind: "exists" };
      await createRepo(id);
      return { kind: "created" };
    });
  }

  /**
   * Build the repo in a staging dir and rename it into place, so a repo that
   * EXISTS always has its baseline: a process killed half-way leaves only a
   * dot-prefixed staging dir, never a history with no `v0`.
   */
  async function createRepo(id: string): Promise<void> {
    const staging = await mkdtemp(join(historyDir, `.staging-${id}-`));
    try {
      await initBareRepo(staging);
      // Dot-files are not part of a prototype (every reader of the tree skips
      // them), and Finder drops a `.DS_Store` into any folder it opens.
      await mkdir(join(staging, "info"), { recursive: true });
      await writeFile(join(staging, "info", "exclude"), ".*\n");

      const git = historyGit(staging, folderOf(id));
      await git.run(["add", "-A"]);
      // --allow-empty: an empty folder still has a v0.
      await commit(
        git,
        {
          subject: "Baseline",
          body: "",
          kind: "baseline",
          conversationId: null,
          messageId: null,
        },
        { allowEmpty: true },
      );
      await stampLatest(staging, (await readEntries(git)).at(-1)!);
      await rename(staging, repoOf(id));
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
  }

  async function adoptAll(): Promise<void> {
    const ids = (await listPrototypeDirNames(root)).filter(protoIdKind.is);
    // One failure must not stop the rest from being adopted; all of them are
    // reported together afterwards.
    const failures: unknown[] = [];
    for (const id of ids) {
      try {
        await ensureHistory(id);
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `could not adopt ${failures.length} prototype histor${failures.length === 1 ? "y" : "ies"} under ${historyDir}`,
      );
    }
  }

  async function checkpoint(
    id: string,
    input: CheckpointInput,
  ): Promise<CheckpointResult> {
    if ((await ensureHistory(id)).kind === "no-such-prototype") {
      return { kind: "no-such-prototype" };
    }
    const git = gitOf(id);
    return withHistoryLock(lockOf(id), async () => {
      if (
        input.messageId !== undefined &&
        (await readEntries(git)).some((v) => v.messageId === input.messageId)
      ) {
        return { kind: "unchanged" };
      }
      const recorded = await commitChanges(git, {
        subject: toSubjectLine(
          input.subject,
          input.kind === "turn" ? "Agent turn" : "Manual checkpoint",
        ),
        body: input.body ?? "",
        kind: input.kind,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
      });
      if (!recorded) return { kind: "unchanged" };
      return { kind: "recorded", version: await afterCommit(id, git) };
    });
  }

  async function readHistory(id: string): Promise<HistoryRead> {
    if ((await ensureHistory(id)).kind === "no-such-prototype") {
      return { kind: "no-such-prototype" };
    }
    const git = gitOf(id);
    const entries = await readEntries(git);
    return {
      kind: "history",
      history: { versions: entries.map(toVersion), dirty: await isDirty(git) },
      entries,
    };
  }

  async function readVersionFile(
    id: string,
    sha: string,
    file: string,
  ): Promise<VersionFileRead> {
    if (!existsSync(repoOf(id))) return { kind: "not-found" };
    const result = await gitOf(id).probe([
      "cat-file",
      "blob",
      `${assertSha(sha)}:${assertFlatFileName(file)}`,
    ]);
    if (result.exitCode !== 0) return { kind: "not-found" };
    return { kind: "found", bytes: result.stdoutBytes };
  }

  async function readVersionPatch(id: string, sha: string): Promise<string> {
    const result = await gitOf(id).run([
      "show",
      "--format=",
      "--patch",
      "--no-color",
      "--no-ext-diff",
      assertSha(sha),
    ]);
    return result.stdout;
  }

  async function restoreVersion(
    id: string,
    sha: string,
  ): Promise<RestoreResult> {
    assertSha(sha);
    if ((await ensureHistory(id)).kind === "no-such-prototype") {
      return { kind: "no-such-prototype" };
    }
    const git = gitOf(id);
    return withHistoryLock(lockOf(id), async () => {
      // An abbreviation must name exactly one version.
      const matches = (await readEntries(git)).filter((v) =>
        v.sha.startsWith(sha),
      );
      const target = matches.length === 1 ? matches[0] : undefined;
      if (target === undefined) return { kind: "unknown-version" };

      await commitChanges(git, {
        subject: "Before restore",
        body: `Unsaved changes, recorded before restoring v${target.n}.`,
        kind: "manual",
        conversationId: null,
        messageId: null,
      });
      // Index AND work tree to the old tree: its files written back, and every
      // file the current version tracks that it lacks deleted. Untracked files
      // (the excluded dot-files) are left alone. The index matches the folder
      // here — the save above staged everything — so nothing is lost.
      await git.run(["read-tree", "-u", "--reset", target.sha]);
      // --allow-empty: restoring the content the folder already has is still
      // the restore the user asked for, and must show up as one.
      await commit(
        git,
        {
          subject: `Restored v${target.n}`,
          body: `Restored from ${target.sha}.`,
          kind: "restore",
          conversationId: null,
          messageId: null,
        },
        { allowEmpty: true },
      );
      return { kind: "restored", version: await afterCommit(id, git) };
    });
  }

  async function readVersionCounts(): Promise<Record<string, number>> {
    let names: string[];
    try {
      names = await readdir(historyDir);
    } catch (err) {
      // No history dir yet: no prototype has a history — a real, empty answer.
      if (isErrnoCode(err, "ENOENT")) return {};
      throw err;
    }
    const ids = names
      .filter((n) => n.endsWith(".git"))
      .map((n) => n.slice(0, -".git".length))
      .filter(protoIdKind.is);
    const counts = await Promise.all(
      ids.map(async (id): Promise<[string, number] | null> => {
        const path = join(repoOf(id), LATEST_STAMP_FILE);
        let text: string;
        try {
          text = await readFile(path, "utf8");
        } catch (err) {
          // A repo recorded before stamps existed: its count is unknown here.
          if (isErrnoCode(err, "ENOENT")) return null;
          throw err;
        }
        const stamp = LatestStampSchema.safeParse(JSON.parse(text));
        if (!stamp.success) {
          throw new Error(
            `malformed version stamp ${path}: ${stamp.error.message}`,
          );
        }
        return [id, stamp.data.n + 1];
      }),
    );
    return Object.fromEntries(counts.filter((c) => c !== null));
  }

  /** Stamp the newest version into the repo, and answer with it. */
  async function afterCommit(
    id: string,
    git: HistoryGit,
  ): Promise<PrototypeVersion> {
    const newest = (await readEntries(git)).at(-1)!;
    await stampLatest(repoOf(id), newest);
    return toVersion(newest);
  }

  return {
    ensureHistory,
    adoptAll,
    checkpoint,
    readHistory,
    readVersionCounts,
    readVersionFile,
    readVersionPatch,
    restoreVersion,
  };
}

/** Stage the whole folder and commit it — only if it differs from the newest version. */
async function commitChanges(
  git: HistoryGit,
  message: VersionMessage,
): Promise<boolean> {
  await git.run(["add", "-A"]);
  const diff = await git.probe(["diff", "--cached", "--quiet"]);
  if (diff.exitCode === 0) return false;
  if (diff.exitCode !== 1) {
    throw new Error(
      `git diff --cached failed (exit ${diff.exitCode}): ${diff.stderr.trim()}`,
    );
  }
  await commit(git, message, { allowEmpty: false });
  return true;
}

async function commit(
  git: HistoryGit,
  message: VersionMessage,
  opts: { allowEmpty: boolean },
): Promise<void> {
  await git.run(
    [
      "commit",
      "--quiet",
      "--no-verify",
      // Not the default `strip`, which would drop every `#` line — a markdown
      // heading in the user's request.
      "--cleanup=whitespace",
      ...(opts.allowEmpty ? ["--allow-empty"] : []),
      "--file=-",
    ],
    { stdin: formatVersionMessage(message) },
  );
}

/** Every version, oldest → newest, each with the options its own page declares. */
async function readEntries(git: HistoryGit): Promise<VersionEntry[]> {
  // Unit separator between fields, record separator between commits: the
  // message writer strips both, so neither can occur inside a field.
  const result = await git.run([
    "log",
    "--reverse",
    "--format=%H%x1f%cI%x1f%B%x1e",
  ]);
  const commits = result.stdout
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record, n) => {
      const [sha, at, raw] = record.split("\x1f");
      return { n, sha: sha!, at: at!, message: parseVersionMessage(raw ?? "") };
    });
  const options = await readVersionOptions(
    git,
    commits.map((c) => c.sha),
  );
  return commits.map(({ n, sha, at, message }) => ({
    n,
    sha,
    at,
    kind: message.kind,
    subject: message.subject,
    conversationId: message.conversationId,
    messageId: message.messageId,
    options: options.get(sha)!,
    body: message.body,
  }));
}

/**
 * Each version's declared options, by commit sha. A commit never changes, so a
 * version's options are read once per process and remembered; this grows with
 * the number of versions recorded on the host, a few hundred bytes each.
 */
const versionOptionsMemo = new Map<string, PrototypeOption[]>();

/**
 * The options of each of `shas`, reading every version not yet remembered in
 * ONE `git cat-file --batch` — a history is re-read on every edit of its
 * folder (the dirty flag), so it must not cost a spawn per version.
 */
async function readVersionOptions(
  git: HistoryGit,
  shas: readonly string[],
): Promise<Map<string, PrototypeOption[]>> {
  const unread = shas.filter((sha) => !versionOptionsMemo.has(sha));
  if (unread.length > 0) {
    const pages = await readBatch(
      git,
      unread.map((sha) => `${sha}:${PROTOTYPE_ENTRY_FILE}`),
    );
    for (const [i, sha] of unread.entries()) {
      const html = pages[i]!;
      // No `index.html` in a version is a version that declares nothing — an
      // empty folder's baseline — not a failed read.
      const options =
        html === null ? [] : (await readPrototypeOptions(html)).options;
      versionOptionsMemo.set(sha, options);
    }
  }
  return new Map(shas.map((sha) => [sha, versionOptionsMemo.get(sha)!]));
}

/**
 * `git cat-file --batch` over `specs` (`<rev>:<path>`): each blob's text, or
 * `null` for one that does not exist, in request order. The protocol frames an
 * object as `<oid> <type> <size>\n<size bytes>\n`, a missing one as
 * `<spec> missing\n`.
 */
async function readBatch(
  git: HistoryGit,
  specs: readonly string[],
): Promise<(string | null)[]> {
  const result = await git.run(["cat-file", "--batch"], {
    stdin: specs.map((s) => `${s}\n`).join(""),
  });
  const buf = result.stdoutBytes;
  const decoder = new TextDecoder();
  const out: (string | null)[] = [];
  let i = 0;
  for (const spec of specs) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) throw new Error(`git cat-file --batch ended before ${spec}`);
    const header = decoder.decode(buf.subarray(i, nl));
    i = nl + 1;
    if (header.endsWith(" missing")) {
      out.push(null);
      continue;
    }
    const size = Number.parseInt(header.split(" ")[2] ?? "", 10);
    if (!Number.isFinite(size)) {
      throw new Error(
        `git cat-file --batch: unreadable header for ${spec}: ${header}`,
      );
    }
    out.push(decoder.decode(buf.subarray(i, i + size)));
    i += size + 1; // content + trailing newline
  }
  return out;
}

/** Does the folder differ from the newest version (staged or not, added or deleted)? */
async function isDirty(git: HistoryGit): Promise<boolean> {
  const result = await git.run([
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  return result.stdout.trim() !== "";
}

function toVersion(entry: VersionEntry): PrototypeVersion {
  return {
    n: entry.n,
    sha: entry.sha,
    at: entry.at,
    kind: entry.kind,
    subject: entry.subject,
    conversationId: entry.conversationId,
    messageId: entry.messageId,
    options: entry.options,
  };
}

/** Write `{ n, sha }` atomically — temp-then-rename, so no reader sees half of it. */
async function stampLatest(repo: string, newest: VersionEntry): Promise<void> {
  const path = join(repo, LATEST_STAMP_FILE);
  // `.tmp`, not `.json`: the watcher's extension filter must not pass the temp.
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify({ n: newest.n, sha: newest.sha }));
  await rename(temp, path);
}

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

// Every argument that becomes a path or a revision is checked before it touches
// the filesystem or a git command line. The predicates are exported so a route
// can answer 404 for a malformed URL; past that, a bad argument is a caller bug,
// so the store throws.

/** A (possibly abbreviated) commit sha — hex only, so it can never be an option or a rev expression. */
export function isVersionSha(sha: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(sha);
}

/** One entry of a flat prototype folder: no separator, no `.`/`..`, no NUL. */
export function isFlatFileName(file: string): boolean {
  return (
    file !== "" &&
    file !== "." &&
    file !== ".." &&
    !/[/\\]/.test(file) &&
    !file.includes("\0")
  );
}

function assertPrototypeId(id: string): string {
  if (!protoIdKind.is(id)) {
    throw new Error(`not a prototype id: ${JSON.stringify(id)}`);
  }
  return id;
}

function assertSha(sha: string): string {
  if (!isVersionSha(sha)) {
    throw new Error(`not a commit sha: ${JSON.stringify(sha)}`);
  }
  return sha;
}

function assertFlatFileName(file: string): string {
  if (!isFlatFileName(file)) {
    throw new Error(
      `not a file name in a prototype folder: ${JSON.stringify(file)}`,
    );
  }
  return file;
}
