import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  keyFileOwner,
  parseKeyFile,
  type KeyFileFacts,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";

// Each plugin key file's facts (`parseKeyFile`: a runtime barrel's own
// `export default { … }` fields, a package.json's description and flags),
// folded along the directory tree: a key file's facts are a function of its
// bytes and which key file it is, so a pass after an edit parses only the key
// files the edit touched — never every barrel of the tree.

/** Repo-relative key file path → its facts (null: empty, i.e. absent). */
export type KeyFactsByFile = Record<string, KeyFileFacts | null>;

/** The plugins root is the repo's `plugins/` folder, so a key file sits at `plugins/<plugin path>/<key file>`. */
const ROOT_PREFIX = "plugins/";

export const keyFactsFold: FileFold<null, KeyFactsByFile> = {
  url: import.meta.url,
  scan(src, rel) {
    const owner = rel.startsWith(ROOT_PREFIX)
      ? keyFileOwner(rel.slice(ROOT_PREFIX.length))
      : null;
    if (owner === null)
      throw new Error(`[structure-records] ${rel} is not a plugin key file`);
    const keyFile = rel.slice(ROOT_PREFIX.length + owner.length + 1);
    return { [rel]: parseKeyFile(keyFile, src, rel) };
  },
  combine: (parts) => Object.assign({}, ...parts) as KeyFactsByFile,
};
