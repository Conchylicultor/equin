import { listPrototypeDirNames } from "../../shared/read-folder";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";

// The lister's implementation moved to `shared/list-metas.ts` so
// `./equin prototype list` can read the tree with no backend running (a
// CLI process cannot import this barrel's boot-time machinery). Nothing in it
// was server-specific.
//
// This file stays as the server's spelling of it: `handlers.ts`, `resources.ts`
// and the server barrel — which `thumbnails` reads `listPrototypeMetas` from —
// all keep importing `./list`, so the move costs no call site and the exported
// API is unchanged.
export {
  listPrototypeMetas,
  readPrototypeMeta,
  readPrototypeTitle,
} from "../../shared/list-metas";

/**
 * The name of every prototype in the tree — the folder listing alone, for a
 * caller that needs which prototypes exist and nothing about them. A
 * `listPrototypeMetas` reads, validates and parses every folder (seconds on a
 * busy host); a consumer keyed by name must not pay that to learn the names.
 */
export async function listPrototypeNames(): Promise<string[]> {
  return await listPrototypeDirNames(prototypesDir.path);
}
