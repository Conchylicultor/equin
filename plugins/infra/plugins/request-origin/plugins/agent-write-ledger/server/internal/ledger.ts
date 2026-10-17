/**
 * Pre-write snapshots of every file an agent-origin request overwrote, so the
 * e2e harness can put them back.
 *
 * ## Why this exists
 *
 * Some UI state is written straight into the user's durable data. A DataView
 * writes its per-view-instance sort / filter / groupBy back through config_v2;
 * a prototype's option picker writes the shared picks record. So an e2e script
 * that clicks "Group by Kind" to verify grouping works leaves the running
 * surface grouped for the user — and poisons its own next run's baseline, which
 * is how this was found (a "0 expanded elements" baseline became 44, so the
 * assertion saw 44 → 44 and failed, looking exactly like a product bug).
 *
 * Design docs:
 * `research/2026-08-30-global-agent-config-write-revert-ledger.md` (the
 * original, config-only ledger) and
 * `research/2026-09-16-global-shared-prototype-option-picks.md` § 4 (this
 * generalization, made when a second domain needed it).
 *
 * ## Shape
 *
 * A domain calls {@link defineAgentWriteLedger} once, at its module eval, and
 * gets a `record` / `noteComplete` handle for its write paths. The ledger owns
 * capture and persistence and knows nothing about the domain: an entry is an
 * opaque `key` plus a named set of files (`Record<K, FileSnapshot>`), and the
 * per-entry apply step — putting the bytes back AND re-syncing whatever cache
 * the domain keeps over them — is the domain's own `restore`.
 *
 * ## Why a module-level registry, not a contribution slot
 *
 * The registry is only READ when a request arrives (the two `/api/agent-writes`
 * routes), which is after the whole plugin graph has loaded — so every
 * `defineAgentWriteLedger` call has already run, whatever order the owners
 * loaded in. A slot would add a load-wave ordering edge for no reader that
 * needs one. (The design doc's original objection was to a slot for a single
 * contributor; with a registry, no load order is load-bearing at all.)
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import type { WriteOrigin } from "@plugins/infra/plugins/request-origin/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import type {
  AgentWriteEntrySummary,
  AgentWriteLedgerSummary,
  AgentWritesRevertOutcome,
  AgentWritesScope,
  AgentWritesStatus,
} from "../../core";
import { inAgentWritesScope } from "../../core";
import { agentWriteLedgerDir } from "../../data-dirs";

/** One file's state. `present: false` is "did not exist", not "empty". */
export type FileSnapshot =
  { present: false } | { present: true; bytes: string };

export interface AgentWriteLedgerEntry<K extends string> {
  ledgerId: string;
  /** The domain's identifier for the thing written. Opaque to the ledger. */
  key: string;
  /**
   * Absolute, captured at record time — so a restore never needs the domain's
   * own registration to still exist (a config descriptor may have been renamed
   * or removed between the run and the revert).
   */
  paths: Record<K, string>;
  /** As they stood BEFORE the first agent write. What a revert restores. */
  before: Record<K, FileSnapshot>;
  /**
   * As the MOST RECENT agent write left them. What a revert compares current
   * disk against, to detect someone else having written on top.
   */
  after: Record<K, FileSnapshot>;
  /** Which automated session, e.g. `e2e:runs-surface`. */
  source: string;
  /** Diagnostics only — `["set-field:views", "delete-override"]`. */
  operations: string[];
  firstWriteAt: string;
  lastWriteAt: string;
}

export interface AgentWriteLedgerOptions<K extends string> {
  /**
   * Stable, and one lowercase kebab segment: it names the ledger's file
   * (`<namespace>/<id>.json`), so changing it strands pending entries.
   */
  id: string;
  /** Human, e.g. "Config documents" — what the harness prints. */
  label: string;
  /**
   * Put one entry's `before` files back and re-sync the domain's caches.
   *
   * Only called after the divergence check passed. A throw leaves the entry in
   * the ledger (reported as `failed`), so the next revert retries it.
   */
  restore: (entry: AgentWriteLedgerEntry<K>) => Promise<void>;
}

export interface AgentWriteLedger<K extends string> {
  /**
   * Record the pre-write state of `key`'s files, about to be written by
   * `writer`. Call immediately BEFORE the file mutation, once the paths are
   * resolved.
   *
   * A no-op for anything but an agent write, so every call site pays one
   * discriminant check and nothing else.
   *
   * **The FIRST write is the one captured.** The ledger answers "what did this
   * look like before the agent touched it at all". On a second write the
   * pre-write bytes ARE the agent's own first write, so capturing them would
   * make the revert restore an intermediate agent state. `before` is therefore
   * first-write-wins; `after` is refreshed by every `noteComplete`, because it
   * is what detects a user edit landing on top.
   */
  record(
    writer: WriteOrigin,
    key: string,
    paths: Record<K, string>,
    operation: string,
  ): void;
  /**
   * Refresh `after` once the write has landed, so the divergence check has the
   * agent's real end state to compare against. Call right AFTER the mutation.
   *
   * Separate from `record` because the bytes only exist after the write. A
   * missed call is not silent corruption — it makes the next revert see a
   * divergence and skip the entry, which is the safe direction.
   */
  noteComplete(writer: WriteOrigin, key: string): void;
}

/** The type-erased face every registered ledger shows the aggregate routes. */
interface RegisteredLedger {
  id: string;
  label: string;
  list(): AgentWriteEntrySummary[];
  revert(scope: AgentWritesScope): Promise<AgentWritesRevertOutcome>;
}

const ledgers = new Map<string, RegisteredLedger>();

/** A ledger id names a file, so it is one lowercase kebab path segment. */
const LEDGER_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const fileSnapshotSchema = z.discriminatedUnion("present", [
  z.object({ present: z.literal(false) }),
  z.object({ present: z.literal(true), bytes: z.string() }),
]);

const ledgerFileSchema = z.object({
  version: z.literal(1),
  entries: z.record(
    z.object({
      ledgerId: z.string(),
      key: z.string(),
      paths: z.record(z.string()),
      before: z.record(fileSnapshotSchema),
      after: z.record(fileSnapshotSchema),
      source: z.string(),
      operations: z.array(z.string()),
      firstWriteAt: z.string(),
      lastWriteAt: z.string(),
    }),
  ),
});

interface LedgerFile<K extends string> {
  version: 1;
  entries: Record<string, AgentWriteLedgerEntry<K>>;
}

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

function snapshotFile(path: string): FileSnapshot {
  const bytes = readOrNull(path);
  return bytes === null ? { present: false } : { present: true, bytes };
}

function snapshotAll<K extends string>(
  paths: Record<K, string>,
): Record<K, FileSnapshot> {
  const out = {} as Record<K, FileSnapshot>;
  for (const role of Object.keys(paths) as K[])
    out[role] = snapshotFile(paths[role]);
  return out;
}

function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  if (!a.present || !b.present) return a.present === b.present;
  return a.bytes === b.bytes;
}

/**
 * Declare a domain's agent-write ledger. Call ONCE, at the owning module's
 * eval; a second ledger with the same `id` throws, since two owners sharing one
 * file would clobber each other's pending entries.
 */
export function defineAgentWriteLedger<K extends string>(
  opts: AgentWriteLedgerOptions<K>,
): AgentWriteLedger<K> {
  const { id, label, restore } = opts;
  if (!LEDGER_ID_RE.test(id)) {
    throw new Error(
      `[agent-write-ledger] ledger id must match ${String(LEDGER_ID_RE)}, got ${JSON.stringify(id)} — it names the ledger's file.`,
    );
  }
  if (ledgers.has(id)) {
    throw new Error(
      `[agent-write-ledger] duplicate ledger id "${id}" (${label}). Each ledger owns one file; pick a distinct id.`,
    );
  }

  // Resolved on first use, not here: declaring a ledger must not require a
  // runtime namespace, so a CLI or test that merely IMPORTS an owner module
  // does not throw. Memoized so the file always agrees with `cached` below.
  let file: string | undefined;
  const ledgerFile = (): string =>
    (file ??= agentWriteLedgerDir.file(runtimeNamespace(), `${id}.json`));

  let cached: LedgerFile<K> | undefined;

  function load(): LedgerFile<K> {
    if (cached) return cached;
    const path = ledgerFile();
    const raw = readOrNull(path);
    if (raw === null) {
      cached = { version: 1, entries: {} };
      return cached;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      throw new Error(
        `[agent-write-ledger] "${id}" ledger at ${path} is not valid JSON: ${err.message}\n` +
          `Delete the file to discard the pending revert.`,
        { cause: err },
      );
    }
    const parsed = ledgerFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `[agent-write-ledger] "${id}" ledger at ${path} is not a version-1 ledger: ${parsed.error.message}\n` +
          `Delete the file to discard the pending revert, or restore a compatible one.`,
      );
    }
    for (const [key, entry] of Object.entries(parsed.data.entries)) {
      if (entry.ledgerId !== id || entry.key !== key) {
        throw new Error(
          `[agent-write-ledger] "${id}" ledger at ${path} holds entry "${key}" recorded as ${entry.ledgerId}/${entry.key}. ` +
            `Delete the file to discard the pending revert.`,
        );
      }
    }
    // The file is this ledger's own output, and K exists only at compile time —
    // the one place the stored roles are taken on trust.
    cached = parsed.data as LedgerFile<K>;
    return cached;
  }

  /**
   * Rewrite the whole file atomically.
   *
   * A full rewrite rather than an append log: writes are human-paced (bounded
   * by the DataView's 400ms debounce), files are a few KB, and a run touches a
   * handful — so this is cheaper than an append log plus its compaction, and it
   * can never be left half-parsed by a SIGKILL mid-write.
   */
  function persist(ledger: LedgerFile<K>): void {
    const path = ledgerFile();
    const tmp = `${path}.tmp-${randomUUID()}`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf-8");
      renameSync(tmp, path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch (unlinkErr: unknown) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT")
          throw unlinkErr;
      }
      throw err;
    }
  }

  const handle: AgentWriteLedger<K> = {
    record(writer, key, paths, operation) {
      if (writer.kind !== "agent") return;

      const ledger = load();
      const now = new Date().toISOString();
      const existing = ledger.entries[key];

      if (existing) {
        // `before` is untouched (first write wins); `after` is refreshed by
        // this write's own `noteComplete`, once its bytes exist.
        existing.operations.push(operation);
        existing.lastWriteAt = now;
        persist(ledger);
        return;
      }

      ledger.entries[key] = {
        ledgerId: id,
        key,
        paths,
        before: snapshotAll(paths),
        // Filled in properly by `noteComplete`. Until then it equals `before`,
        // so a process that died between the write and the note makes the next
        // revert see a divergence and leave the entry alone — the safe way.
        after: snapshotAll(paths),
        source: writer.source,
        operations: [operation],
        firstWriteAt: now,
        lastWriteAt: now,
      };
      persist(ledger);
    },

    noteComplete(writer, key) {
      if (writer.kind !== "agent") return;
      const ledger = load();
      const entry = ledger.entries[key];
      if (!entry) return;
      entry.after = snapshotAll(entry.paths);
      persist(ledger);
    },
  };

  ledgers.set(id, {
    id,
    label,
    list() {
      return Object.values(load().entries).map(
        ({ key, source, operations, firstWriteAt, lastWriteAt }) => ({
          key,
          source,
          operations,
          firstWriteAt,
          lastWriteAt,
        }),
      );
    },

    async revert(scope) {
      const ledger = load();
      const outcome: AgentWritesRevertOutcome = {
        reverted: [],
        diverged: [],
        failed: [],
      };

      for (const [key, entry] of Object.entries(ledger.entries)) {
        // Another session's write: theirs to revert, whenever they end.
        if (!inAgentWritesScope(scope, entry.source)) continue;
        try {
          // Divergence check FIRST. If the files moved since the agent's last
          // write, someone else owns them now — restoring would destroy their
          // edit. Skip and drop the entry: the agent's change is frozen in,
          // which is correct, because the user demonstrably touched this.
          const current = snapshotAll(entry.paths);
          const moved = (Object.keys(entry.paths) as K[]).filter(
            (role) => !sameSnapshot(current[role], entry.after[role]),
          );
          if (moved.length > 0) {
            outcome.diverged.push({
              ledgerId: id,
              label,
              key,
              detail: `${moved.join(", ")} changed after the agent last wrote it`,
            });
            delete ledger.entries[key];
            continue;
          }

          await restore(entry);
          outcome.reverted.push({
            ledgerId: id,
            label,
            key,
            source: entry.source,
          });
          delete ledger.entries[key];
        } catch (err) {
          // Wrapped per entry so one bad entry cannot strand the other twenty,
          // and LEFT IN the ledger so the next start-repair retries it. Never
          // swallowed: it lands in `failed`, which the harness turns into a
          // FAIL.
          outcome.failed.push({
            ledgerId: id,
            label,
            key,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      persist(ledger);
      return outcome;
    },
  });

  return handle;
}

/** Every ledger as the status endpoint reports it. */
export function listAgentWrites(): AgentWritesStatus {
  const summaries: AgentWriteLedgerSummary[] = [...ledgers.values()].map(
    (ledger) => ({
      id: ledger.id,
      label: ledger.label,
      entries: ledger.list(),
    }),
  );
  let lastWriteAt: string | null = null;
  for (const entry of summaries.flatMap((s) => s.entries)) {
    if (lastWriteAt === null || entry.lastWriteAt > lastWriteAt)
      lastWriteAt = entry.lastWriteAt;
  }
  return { ledgers: summaries, lastWriteAt };
}

/**
 * Restore every entry in `scope`, across every registered ledger, and clear
 * what was restored.
 *
 * Idempotent: nothing in scope returns three empty arrays, which is what makes
 * it safe to call at the start of every run as a repair for a previous run
 * that was killed before its own revert. Ledgers run one after another, in the
 * order they were defined.
 *
 * An entry carries the source of the FIRST agent write to its key; a key two
 * sessions both wrote is reverted with the first one.
 */
export async function revertAgentWritesIn(
  scope: AgentWritesScope,
): Promise<AgentWritesRevertOutcome> {
  const outcome: AgentWritesRevertOutcome = {
    reverted: [],
    diverged: [],
    failed: [],
  };
  for (const ledger of ledgers.values()) {
    const one = await ledger.revert(scope);
    outcome.reverted.push(...one.reverted);
    outcome.diverged.push(...one.diverged);
    outcome.failed.push(...one.failed);
  }
  return outcome;
}
