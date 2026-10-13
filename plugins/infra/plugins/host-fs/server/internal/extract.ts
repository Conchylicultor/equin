import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import {
  hostFsExtract,
  type HostFsArchiveReason,
  type HostFsExtractResult,
} from "../../core";
import { locateHostPath } from "./archive/locate";
import { isCorruptStream } from "./archive/read";
import { archiveFormatFor } from "./archive/registry";
import { archiveTree } from "./archive/tree";
import { isAppOrigin } from "./open";
import { classifyFsError, resolveHostPath } from "./path";

/**
 * What an extraction leaves out, as the Finder does: macOS's `__MACOSX/` tree
 * of AppleDouble resource forks, and `.DS_Store` folder settings.
 */
function isJunk(inner: string): boolean {
  if (inner === "__MACOSX" || inner.startsWith("__MACOSX/")) return true;
  return inner === ".DS_Store" || inner.endsWith("/.DS_Store");
}

/** The folder an archive's members are extracted into: its name less the extension. */
function folderNameFor(archiveName: string): string {
  const stem = archiveName.slice(
    0,
    archiveName.length - extname(archiveName).length,
  );
  return stem === "" ? archiveName : stem;
}

async function isTaken(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (classifyFsError(err) === "missing") return false;
    throw err;
  }
}

/**
 * `name` in `dir`, or — when that is taken — the Finder's next free spelling:
 * `photos 2`, `photos 3`, … for a folder, `a 2.txt` for a file.
 */
async function freePath(
  dir: string,
  name: string,
  isFile: boolean,
): Promise<string> {
  const ext = isFile ? extname(name) : "";
  const stem = name.slice(0, name.length - ext.length);
  let candidate = join(dir, name);
  for (let n = 2; await isTaken(candidate); n++) {
    candidate = join(dir, `${stem} ${n}${ext}`);
  }
  return candidate;
}

/**
 * Extract the archive file at `path` (absolute) beside itself: one top-level
 * entry is extracted as itself, several into a new folder named after the
 * archive. Members are written into a hidden staging folder next to the
 * archive and moved into place once all of them are, so a failure (an
 * encrypted or corrupt member, a full disk) leaves nothing half-extracted.
 */
export async function extractHostArchive(
  path: string,
): Promise<HostFsExtractResult> {
  const located = await locateHostPath(path);
  if (located.kind === "archive") return { kind: "not-an-archive", path };
  const format = archiveFormatFor(basename(path));
  try {
    if (format === undefined || !(await stat(path)).isFile()) {
      return { kind: "not-an-archive", path };
    }
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
  const unreadable = (reason: HostFsArchiveReason): HostFsExtractResult => ({
    kind: "unreadable-archive",
    path,
    archive: path,
    reason,
  });

  let indexed;
  try {
    indexed = await archiveTree(path, format);
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
  if (indexed.kind === "unreadable") return unreadable(indexed.reason);
  const tree = indexed.tree;

  const roots = (tree.children.get("") ?? []).filter((e) => !isJunk(e.name));
  const single = roots.length === 1 ? roots[0]! : null;
  const dir = dirname(path);
  const staging = join(dir, `.${basename(path)}.extracting-${randomUUID()}`);
  try {
    await mkdir(staging);
  } catch (err) {
    return { kind: classifyFsError(err), path };
  }
  try {
    const dirs: [string, number][] = [];
    for (const [inner, entry] of tree.entries) {
      if (inner === "" || isJunk(inner) || entry.kind !== "dir") continue;
      await mkdir(join(staging, inner), { recursive: true });
      dirs.push([inner, entry.mtimeMs]);
    }
    for (const [inner, member] of tree.files) {
      if (isJunk(inner)) continue;
      const dest = join(staging, inner);
      await mkdir(dirname(dest), { recursive: true });
      const bytes = await member.open();
      if (bytes.kind === "unreadable") return unreadable(bytes.reason);
      if (bytes.body instanceof Blob) await Bun.write(dest, bytes.body);
      else await Bun.write(dest, new Response(bytes.body));
      await utimes(dest, member.mtimeMs / 1000, member.mtimeMs / 1000);
    }
    // Last, deepest first: writing a folder's children bumps its mtime.
    dirs.sort(([a], [b]) => b.split("/").length - a.split("/").length);
    for (const [inner, mtimeMs] of dirs) {
      await utimes(join(staging, inner), mtimeMs / 1000, mtimeMs / 1000);
    }

    const created = single
      ? await freePath(dir, single.name, single.kind !== "dir")
      : await freePath(dir, folderNameFor(basename(path)), false);
    await rename(single ? join(staging, single.name) : staging, created);
    return {
      kind: "extracted",
      path,
      created,
      layout: single ? "single" : "folder",
    };
  } catch (err) {
    if (isCorruptStream(err)) return unreadable("corrupt");
    throw err;
  } finally {
    // Gone already when the staging folder itself was moved into place.
    await rm(staging, { recursive: true, force: true });
  }
}

export const handleExtract = implement(hostFsExtract, ({ body, req }) => {
  if (!isAppOrigin(req.headers.get("origin"))) {
    throw new HttpError(
      403,
      "Extract is only accepted from the app's own *.localhost origin",
    );
  }
  return extractHostArchive(resolveHostPath(body.path));
});
