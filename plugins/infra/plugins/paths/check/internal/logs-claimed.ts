import { readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
// Own plugin, so relative (see ../index.ts).
import { checkoutWorktreeName } from "../../core/internal/paths";
import { getDataDirs, isDataDir } from "../../core/internal/data-dir";
import type { DataDir, DataDirKind } from "../../core/internal/data-dir";
import {
  readForeignManifests,
  type DataDirsManifest,
} from "../../core/internal/data-dirs-manifest";
import {
  LOG_FILE_RE,
  logPatternMatches,
  publishedLogClaim,
  type LogClaim,
} from "../../core/internal/log-claims";

// ── paths:logs-claimed ──────────────────────────────────────────────────────
//
// Every log file under the data root is claimed by the data dir that holds it,
// with what keeps it finite (`core/internal/log-claims.ts`). Written after a
// 1.7 GB postgres.log, a 1.4 GB pgbouncer.log and 1.9 GB of reaped namespaces'
// gateway logs were each found by accident, months in (2026-11-04).
//
// Scanned: every declared dir of the kinds logs are written to (`logs`,
// `services`), and any other dir that declares claims. Not scanned: `cache`,
// `state`, `apps` (their files are data, bounded by reclaim and retention, not
// rotation) and `worktrees` (a namespace's registry dir is deleted with it,
// and its run artifacts are pruned by RUN_ARTIFACTS_RETENTION); a dir nested
// inside another declared dir is scanned as its own.
//
// Host-scoped like `paths:no-undeclared-data-dirs`, for the same reason: the
// root holds the union of every branch on the machine, so a claim another live
// branch declares (published in its data-dirs manifest) excuses its file here.

/** The kinds whose every dir is scanned, claims or not. */
const SCANNED_KINDS: ReadonlySet<DataDirKind> = new Set(["logs", "services"]);

/** One declared dir to audit: its key, where it is, and what it claims. */
export interface ClaimingDir {
  key: string;
  root: string;
  claims: readonly LogClaim[];
}

/** A log file found under a dir, relative to it, with its size. */
export interface FoundLog {
  rel: string;
  bytes: number;
}

export interface LogAudit {
  /** Files no claim matches, local or foreign: `<key>/<rel>` with their size. */
  unclaimed: { path: string; bytes: number }[];
  /** Debt-claimed families that hold files: what they hold and the task that bounds them. */
  debt: { claim: string; task: string; files: number; bytes: number }[];
  /** Files another live branch claims and this checkout does not. */
  attributed: { path: string; owners: string[] }[];
}

/**
 * The decision, pure: each dir's files against its own claims first, then
 * against the claims other namespaces publish for the same dir.
 */
export function auditLogs(
  dirs: readonly { dir: ClaimingDir; files: readonly FoundLog[] }[],
  foreign: readonly DataDirsManifest[],
): LogAudit {
  const audit: LogAudit = { unclaimed: [], debt: [], attributed: [] };
  const debt = new Map<string, LogAudit["debt"][number]>();
  for (const { dir, files } of dirs) {
    for (const file of files) {
      const claim = dir.claims.find((c) =>
        logPatternMatches(c.pattern, file.rel),
      );
      if (claim) {
        if (claim.bound.kind === "debt") {
          const id = publishedLogClaim(dir.key, claim.pattern);
          const entry = debt.get(id) ?? {
            claim: id,
            task: claim.bound.task,
            files: 0,
            bytes: 0,
          };
          entry.files++;
          entry.bytes += file.bytes;
          debt.set(id, entry);
        }
        continue;
      }
      const path = `${dir.key}/${file.rel}`;
      const owners = foreign
        .filter((m) =>
          m.logClaims.some((published) => {
            const sep = published.indexOf(":");
            return (
              published.slice(0, sep) === dir.key &&
              logPatternMatches(published.slice(sep + 1), file.rel)
            );
          }),
        )
        .map((m) => m.namespace);
      if (owners.length > 0) audit.attributed.push({ path, owners });
      else audit.unclaimed.push({ path, bytes: file.bytes });
    }
  }
  audit.debt = [...debt.values()].sort((a, b) =>
    a.claim.localeCompare(b.claim),
  );
  return audit;
}

/**
 * Every log file under `root`, relative to it: symlinks are never followed
 * (the root's compatibility links point back into `logs/`), and a subtree that
 * is another declared dir is left to that dir's own scan.
 */
async function findLogs(
  root: string,
  skip: ReadonlySet<string>,
): Promise<FoundLog[]> {
  const found: FoundLog[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // A declared dir nothing has created yet holds nothing.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skip.has(abs)) await walk(abs, rel);
      } else if (e.isFile() && LOG_FILE_RE.test(e.name)) {
        found.push({ rel, bytes: (await stat(abs)).size });
      }
    }
  };
  await walk(root, "");
  return found;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const logsClaimedCheck: Check = {
  id: "paths:logs-claimed",
  description:
    "Every *.log / *.jsonl file (and its rotations) in a declared `logs` or `services` data dir — or in any data dir declaring log claims — matches a log claim (defineDataDir's `logs`) naming what keeps it finite: a file sink, the gateway's rotating writer, truncate-on-start, or a debt with its task.",
  // The subject is the machine's data root, not the tree (see the header).
  // Its files change with every write, so there is nothing cheaper than the
  // scan itself to key a verdict on: never cached.
  scope: "host",
  cacheSignature: () => null,
  async run(ctx: CheckContext): Promise<CheckResult> {
    const { dataDirsEntries } = await import("../../core/data-dirs.generated");
    await loadCollectedDir<DataDir>(dataDirsEntries, {
      isItem: isDataDir,
      dedupeKey: (d) => `${d.spec.kind}/${d.spec.name}`,
      label: "data-dir",
    });
    const declared = getDataDirs();
    const roots = new Set([...declared.values()].map((d) => d.path));
    const scanned = await Promise.all(
      [...declared]
        .filter(
          ([, d]) =>
            SCANNED_KINDS.has(d.spec.kind) || (d.spec.logs ?? []).length > 0,
        )
        .map(async ([key, d]) => {
          const root = d.path;
          const others = new Set([...roots].filter((r) => r !== root));
          return {
            dir: { key, root, claims: d.spec.logs ?? [] },
            files: await findLogs(root, others),
          };
        }),
    );
    const foreign = readForeignManifests(
      checkoutWorktreeName(await getWorktreeRoot()),
    );
    const audit = auditLogs(scanned, foreign.manifests);

    for (const d of audit.debt) {
      ctx.log?.(
        `paths:logs-claimed: ${d.claim} — ${d.files} file(s), ${mb(d.bytes)}, unbounded until ${d.task}`,
        "stdout",
      );
    }
    if (audit.attributed.length > 0) {
      ctx.log?.(
        `paths:logs-claimed: ${audit.attributed.length} log file(s) claimed by another live worktree rather than this checkout — ` +
          audit.attributed
            .map((a) => `${a.path} (${a.owners.join(", ")})`)
            .join(", "),
        "stdout",
      );
    }
    if (audit.unclaimed.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${audit.unclaimed.length} log file(s) under the data root no data dir claims:\n    ` +
        audit.unclaimed.map((u) => `${u.path} (${mb(u.bytes)})`).join("\n    "),
      hint:
        "Declare the file on the data dir that holds it — `logs: [{ pattern, bound }]` in its defineDataDir — naming what keeps it finite: " +
        '{ kind: "file-sink" } (written through defineFileSink), { kind: "gateway-rotating" } (the gateway\'s rotatingWriter), ' +
        '{ kind: "rotates-itself", how } (a host script rotating its own file), { kind: "truncate-on-start", reason }, or { kind: "debt", reason, task } with the task that bounds it. ' +
        "A writer nothing bounds is the bug: route it through a file sink rather than claiming it. See plugins/infra/plugins/paths/core/internal/log-claims.ts.",
    };
  },
};
