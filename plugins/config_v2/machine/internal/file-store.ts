import {
  existsSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  APP_SCOPE_DIR,
  appScopeId,
  configFileRelPath,
  scopeSegment,
  storePathParts,
} from "../../core";
import type {
  ConfigDocRef,
  ConfigDocumentFile,
  ConfigFileRef,
  ConfigStoreImpl,
} from "../../core";
import { reloadConfigDocument } from "@plugins/config_v2/server";
import {
  defineAgentWriteLedger,
  type AgentWriteLedgerEntry,
  type FileSnapshot,
} from "@plugins/infra/plugins/request-origin/plugins/agent-write-ledger/server";
import { CONFIG_DIR } from "./config-dir";
import { configFilesWatcherArmed, watchFileChange } from "./config-watcher";
import { configLedgerDocument, configLedgerKey } from "./config-ledger-key";
import { jsoncConfigProxy, writeRawAtomic } from "./jsonc-proxy";

/** Where a user-layer file lives on this machine. */
export function userFilePath(ref: ConfigFileRef): string {
  return join(CONFIG_DIR, configFileRelPath(ref));
}

/** The trio of files a document is made of, for the agent-write ledger. */
function trioPaths(doc: ConfigDocRef): Record<ConfigDocumentFile, string> {
  const path = (file: ConfigDocumentFile) => userFilePath({ ...doc, file });
  return {
    origin: path("origin"),
    override: path("override"),
    ancestor: path("ancestor"),
  };
}

/**
 * The config documents an agent-origin request overwrote, held so the e2e
 * harness can put them back — config's ledger in the shared agent-write ledger
 * primitive. Design:
 * `research/2026-08-30-global-agent-config-write-revert-ledger.md`.
 *
 * Every registry write goes through the store's `edit`, which records the
 * document's whole trio here before the mutation and what it left after: a fork
 * writes the scoped origin as well as the override, an unfork removes both,
 * the conflict resolvers touch the ancestor. Capturing the trio uniformly is
 * correct for every write path, with no per-operation knowledge.
 */
const configWriteLedger = defineAgentWriteLedger<ConfigDocumentFile>({
  id: "config",
  label: "Config documents",
  restore: applyRestore,
});

/** Put one captured file back: exact bytes, or gone if it did not exist. */
function restoreFile(path: string, snapshot: FileSnapshot): void {
  if (snapshot.present) {
    writeRawAtomic(path, snapshot.bytes);
    return;
  }
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Restore one ledgered document's files, then have the registry re-sync its
 * cache (`reloadConfigDocument`) — the watcher is a push-latency mechanism, not
 * a correctness one, so the restore cannot wait for its event.
 *
 * The ledger's `restore` for {@link configWriteLedger}; it has already checked
 * that no file moved since the agent's last write.
 */
async function applyRestore(
  entry: AgentWriteLedgerEntry<ConfigDocumentFile>,
): Promise<void> {
  restoreFile(entry.paths.origin, entry.before.origin);
  restoreFile(entry.paths.override, entry.before.override);
  restoreFile(entry.paths.ancestor, entry.before.ancestor);
  const { storePath, scopeId } = configLedgerDocument(entry.key);
  await reloadConfigDocument(storePath, scopeId);
}

// Identity stamp for one file: "-" when absent, else (inode, mtime-ns, size).
//
// `ino` is what makes this airtight rather than merely likely. Every writer in
// this store goes through jsoncConfigProxy.write, which writes a temp file and
// renames it into place — so the inode changes on EVERY write, including an
// acknowledge-conflict restamp that only swaps the 12 hex chars in the `// @hash`
// header and is therefore byte-length-identical (and can land in the same
// millisecond) as the file it replaced. mtime-ns + size then cover in-place
// writes from an external editor.
function fileStamp(path: string): string {
  const st = statSync(path, { bigint: true, throwIfNoEntry: false });
  if (!st) return "-";
  return `${st.ino}:${st.mtimeNs}:${st.size}`;
}

/**
 * The desktop's user layer: the namespace's config dir
 * (`~/.singularity/state/config/<namespace>/`), one JSONC file per document
 * file, watched by the config-files watcher, with every agent-origin write
 * ledgered.
 */
export const fileConfigStore: ConfigStoreImpl = {
  proxy: (ref) => jsoncConfigProxy(userFilePath(ref)),
  remove(ref) {
    const path = userFilePath(ref);
    if (existsSync(path)) unlinkSync(path);
  },
  stamp: (ref) => fileStamp(userFilePath(ref)),
  // Every scope with a directory under the hierarchy's `@app/`. A missing
  // `@app` dir → [].
  scopes(storePath) {
    const appDir = join(
      CONFIG_DIR,
      storePathParts(storePath).hier,
      APP_SCOPE_DIR,
    );
    if (!existsSync(appDir)) return [];
    return readdirSync(appDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => appScopeId(e.name));
  },
  dropScope(storePath, scopeId) {
    const dir = join(
      CONFIG_DIR,
      storePathParts(storePath).hier,
      scopeSegment(scopeId),
    );
    if (!existsSync(dir)) return;
    try {
      rmdirSync(dir);
    } catch (err) {
      // Dir not empty (another descriptor still has files there, or it's being
      // cleaned by a concurrent op) — leave it. Anything else is unexpected.
      if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw err;
    }
  },
  watch(doc, onChange) {
    const watches = (["override", "origin"] as const).map((file) =>
      watchFileChange(userFilePath({ ...doc, file }), onChange),
    );
    return {
      dispose: () => {
        for (const w of watches) w.dispose();
      },
    };
  },
  armed: configFilesWatcherArmed,
  edit(doc, writer, operation, mutate) {
    const key = configLedgerKey(doc.storePath, doc.scopeId ?? "");
    // A no-op for every writer but an agent; call immediately BEFORE the
    // mutation, and refresh "what the agent left" once it has landed.
    configWriteLedger.record(writer, key, trioPaths(doc), operation);
    const result = mutate();
    configWriteLedger.noteComplete(writer, key);
    return result;
  },
};
