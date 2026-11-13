import { readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
// Own plugin, so relative (see ../index.ts).
import { checkoutWorktreeName } from "../../core/internal/paths";
import { getDataDirs } from "../../core/internal/data-dir";
import type { DataDirKind } from "../../core/internal/data-dir";
import { settleDeclaredDataDirMoves } from "../../core/internal/settle-declared-moves";
import {
  readForeignManifestsSync,
  type DataDirsManifest,
} from "../../core/internal/data-dirs-manifest";
import {
  globMatches,
  LOG_FILE_RE,
  logPatternMatches,
  type NotLogs,
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
// inside another declared dir is scanned as its own, and a subtree a dir
// declares `notLogs` (data in another program's format, or deleted whole by a
// retention) is not entered.
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

/** A log file found under a dir: relative to it, and where it is. */
export interface FoundLog {
  rel: string;
  abs: string;
}

export interface LogAudit {
  /** Files no claim matches, local or foreign: `<key>/<rel>` and where it is. */
  unclaimed: { path: string; abs: string }[];
  /** Debt-claimed families that hold files: the files and the task that bounds them. */
  debt: { claim: string; task: string; files: string[] }[];
  /** Files another live branch claims and this checkout does not. */
  attributed: { path: string; owners: string[] }[];
}

/**
 * The decision, pure: each dir's files against its own claims first, then
 * against the claims other namespaces publish for the same dir. `foreign` is
 * asked for only when a file no local claim matches needs it — reading every
 * other namespace's manifest is the expensive half, and a root whose files are
 * all claimed here has no question for them.
 */
export function auditLogs(
  dirs: readonly { dir: ClaimingDir; files: readonly FoundLog[] }[],
  foreign: () => readonly DataDirsManifest[],
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
            files: [],
          };
          entry.files.push(file.abs);
          debt.set(id, entry);
        }
        continue;
      }
      const path = `${dir.key}/${file.rel}`;
      const owners = foreign()
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
      else audit.unclaimed.push({ path, abs: file.abs });
    }
  }
  audit.debt = [...debt.values()].sort((a, b) =>
    a.claim.localeCompare(b.claim),
  );
  return audit;
}

/**
 * Every log file under `root`, relative to it: symlinks are never followed
 * (the root's compatibility links point back into `logs/`), a subtree that is
 * another declared dir is left to that dir's own scan, and a subtree the dir
 * declares `notLogs` is not entered. Listings only: a file's size is read
 * later, for the files a message reports.
 */
export async function findLogs(
  root: string,
  skip: ReadonlySet<string>,
  notLogs: readonly NotLogs[],
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
        if (skip.has(abs)) continue;
        if (notLogs.some((n) => globMatches(n.pattern, rel))) continue;
        await walk(abs, rel);
      } else if (e.isFile() && LOG_FILE_RE.test(e.name)) {
        found.push({ rel, abs });
      }
    }
  };
  await walk(root, "");
  return found;
}

/** A file's size, or 0 when it went between the listing and now (a rotation). */
async function sizeOf(abs: string): Promise<number> {
  try {
    return (await stat(abs)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
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
    // Loads every declaration, and settles their moves (inspecting only) so
    // the `.path` reads below can resolve a moved dir.
    await settleDeclaredDataDirMoves({ perform: false });
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
            files: await findLogs(root, others, d.spec.notLogs ?? []),
          };
        }),
    );
    const self = checkoutWorktreeName(await getWorktreeRoot());
    let foreign: readonly DataDirsManifest[] | undefined;
    const audit = auditLogs(
      scanned,
      () => (foreign ??= readForeignManifestsSync(self).manifests),
    );

    for (const d of audit.debt) {
      const sizes = await Promise.all(d.files.map(sizeOf));
      const bytes = sizes.reduce((a, b) => a + b, 0);
      ctx.log?.(
        `paths:logs-claimed: ${d.claim} — ${d.files.length} file(s), ${mb(bytes)}, unbounded until ${d.task}`,
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
    const sizes = await Promise.all(audit.unclaimed.map((u) => sizeOf(u.abs)));
    return {
      ok: false,
      message:
        `${audit.unclaimed.length} log file(s) under the data root no data dir claims:\n    ` +
        audit.unclaimed
          .map((u, i) => `${u.path} (${mb(sizes[i]!)})`)
          .join("\n    "),
      hint:
        "Declare the file on the data dir that holds it — `logs: [{ pattern, bound }]` in its defineDataDir — naming what keeps it finite: " +
        '{ kind: "file-sink" } (written through defineFileSink), { kind: "gateway-rotating" } (the gateway\'s rotatingWriter), ' +
        '{ kind: "rotates-itself", how } (a host script rotating its own file), { kind: "truncate-on-start", reason }, or { kind: "debt", reason, task } with the task that bounds it. ' +
        "A writer nothing bounds is the bug: route it through a file sink rather than claiming it. See plugins/infra/plugins/paths/core/internal/log-claims.ts.",
    };
  },
};
