import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import {
  readPrototypeMeta as readMetaOver,
  readPrototypeTitle as readTitleOver,
} from "../../shared/list-metas";
import { listPrototypeDirNames } from "../../shared/read-folder";
import type { PrototypeMeta } from "../../core";
import { prototypeRecords } from "./tree-records";

// The lister (`shared/list-metas.ts`, shared with `./equin prototype list`)
// over the app's file root — the server's spelling of it. `handlers.ts`,
// `resources.ts` and the server barrel (which `thumbnails` and `active-data`
// read from) call these.

/**
 * Every prototype in the tree, as the gallery lists it — composed from the
 * records the watcher keeps (`tree-records.ts`): no file system call but the
 * first read of a folder that moved since the last list.
 */
export function listPrototypeMetas(): Promise<PrototypeMeta[]> {
  return prototypeRecords.list();
}

/**
 * The name of every prototype in the tree — the folder listing alone, for a
 * caller that needs which prototypes exist and nothing about them, read off
 * the disk now.
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
