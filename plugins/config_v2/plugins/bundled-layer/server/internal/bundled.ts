import {
  committedDocument,
  committedFilesFromMap,
} from "@plugins/config_v2/core";
import type {
  CommittedFiles,
  ConfigGitLayerImpl,
} from "@plugins/config_v2/core";

/** The bundle keys' prefix: the glob below is root-absolute. */
const CONFIG_PREFIX = "/config/";

/**
 * The repo's whole `config/`, inlined into the bundle as text by the bundler
 * that builds a browser host (vite rewrites `import.meta.glob` with `?raw`
 * wherever it is written). All of it, not a composition's share: the committed
 * layer is composition-invariant, and a document no registered descriptor reads
 * is never parsed (the memory store seeds per storePath, on first touch).
 *
 * The pattern is ROOT-absolute — the host build's `root` is the repo
 * (`web-artifacts`' browser hosts) — so it names the same `config/` that
 * `repoConfigDir()` names on the desktop, and survives a `plugin move`. It is a
 * literal, as vite requires; the host's address lists its static base
 * recursively, so a new config file re-addresses the host.
 *
 * Inside a function, not at module scope: Bun has no `import.meta.glob`, and
 * docgen imports every server barrel under Bun.
 */
function bundledConfigFiles(): Map<string, string> {
  const files = import.meta.glob<string>("/config/**/*.jsonc", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const out = new Map<string, string>();
  for (const [key, text] of Object.entries(files)) {
    if (!key.startsWith(CONFIG_PREFIX)) {
      throw new Error(`bundled config: unexpected bundle key "${key}"`);
    }
    out.set(key.slice(CONFIG_PREFIX.length), text);
  }
  // An empty map is a bundler that stopped expanding the glob, never a repo
  // with no config: fail rather than read every document as "not committed".
  if (out.size === 0) {
    throw new Error(
      "bundled config: the host bundle holds no config/ file — import.meta.glob was not expanded",
    );
  }
  return out;
}

let files: CommittedFiles | undefined;

/** The committed layer of a browser host: the bundled `config/`, indexed on first read. */
export const bundledConfigLayer: ConfigGitLayerImpl = {
  document(storePath) {
    files ??= committedFilesFromMap(bundledConfigFiles());
    return committedDocument(storePath, files);
  },
};
