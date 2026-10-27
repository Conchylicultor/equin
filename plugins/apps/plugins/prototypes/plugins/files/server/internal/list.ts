import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import {
  listPrototypeMetas as listMetasOver,
  readPrototypeMeta as readMetaOver,
  readPrototypeTitle as readTitleOver,
} from "../../shared/list-metas";
import { listPrototypeDirNames } from "../../shared/read-folder";
import type { PrototypeMeta } from "../../core";

// The lister (`shared/list-metas.ts`, shared with `./equin prototype list`)
// over the app's file root — the server's spelling of it. `handlers.ts`,
// `resources.ts` and the server barrel (which `thumbnails` and `active-data`
// read from) call these.

/** Every prototype in the tree, as the gallery lists it. */
export function listPrototypeMetas(): Promise<PrototypeMeta[]> {
  return listMetasOver(prototypesFiles);
}

/**
 * The name of every prototype in the tree — the folder listing alone, for a
 * caller that needs which prototypes exist and nothing about them. A
 * `listPrototypeMetas` reads, validates and parses every folder (seconds on a
 * busy host); a consumer keyed by name must not pay that to learn the names.
 */
export function listPrototypeNames(): Promise<string[]> {
  return listPrototypeDirNames(prototypesFiles);
}

/**
 * One prototype's `PrototypeMeta`, read from its own folder alone — for a
 * caller that names one prototype. `null` when no such prototype is in the
 * tree.
 */
export function readPrototypeMeta(name: string): Promise<PrototypeMeta | null> {
  return readMetaOver(prototypesFiles, name);
}

/** One prototype's display title, read from its `index.html` alone. */
export function readPrototypeTitle(
  name: string,
): Promise<{ found: true; title: string } | { found: false }> {
  return readTitleOver(prototypesFiles, name);
}
