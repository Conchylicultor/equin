// Reading the whole prototypes tree into `PrototypeMeta[]` — THE one
// implementation, for the two processes that need it.
//
// `shared/`, not `server/`, for the reason `read-folder.ts` is: `./equin
// prototype list` must answer with no backend running, and a CLI process
// cannot import a server barrel's boot-time machinery to do it. Over a `Mount`:
// the server hands it the `prototypesFiles` root (`server/internal/list.ts`,
// whose wrappers keep the server barrel's API), the CLI a disk mount of the
// same data dir.

import {
  InvalidRelPathError,
  readText,
  relPath,
  type Mount,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { scanHtml } from "@plugins/infra/plugins/html-decode/core";
import {
  PROTOTYPE_ENTRY_FILE,
  UNTITLED_PROTOTYPE,
  parseMocks,
  parseViewport,
  DEFAULT_PROTOTYPE_VIEWPORT,
  nonTokenNamesOf,
  problemsOf,
  readPrototypeOptions,
  scanPrototypeFolder,
  type MocksDeclaration,
  type PrototypeFolder,
  type PrototypeMeta,
  type PrototypeProblem,
  type PrototypeScan,
  type PrototypeViewport,
} from "../core";
import { listPrototypeDirNames, readFolderTexts } from "./read-folder";
import {
  folderFilesOf,
  revOfSignature,
  signatureOfFiles,
  type FolderFile,
} from "./folder-signature";

/** What `index.html` declares about itself, before defaults are folded in. */
interface HtmlMeta {
  title: string;
  blurb: string;
  viewport: PrototypeViewport;
  mocks: MocksDeclaration;
}

/**
 * Pull `<title>` and the three `<meta>` tags out of a prototype's `index.html`.
 *
 * Read with `html-decode`'s scanner, which hands every value back decoded
 * exactly once.
 *
 * First occurrence wins for each tag: a `<title>` further down the document
 * (inside an inline `<svg>`, say) is not the document's title.
 */
function parseHtmlMeta(html: string): HtmlMeta {
  let titleText: string | undefined;
  let blurbRaw: string | undefined;
  let viewportRaw: string | undefined;
  let mocksRaw: string | undefined;

  scanHtml(html, {
    elements: {
      meta(el) {
        const name = el.attr("name");
        if (name === "description") {
          blurbRaw ??= el.attr("content");
        } else if (name === "prototype-viewport") {
          viewportRaw ??= el.attr("content");
        } else if (name === "mocks") {
          mocksRaw ??= el.attr("content");
        }
      },
    },
    text: {
      title(text) {
        titleText ??= text;
      },
    },
  });

  // An unreadable size is also a `problems[]` entry, from the same parser
  // (`validatePrototypeFolder`); here it reads as the default.
  const viewport = parseViewport(viewportRaw);

  return {
    title: (titleText ?? "").trim(),
    blurb: (blurbRaw ?? "").trim(),
    viewport: viewport.ok ? viewport.viewport : DEFAULT_PROTOTYPE_VIEWPORT,
    // Declaring no counterpart is the ordinary case, so the absent tag parses
    // to `none` — there is nothing wrong with a prototype that mocks nothing.
    // A malformed line parses to `malformed` here AND is reported by
    // `validatePrototypeFolder` as a problem; both come from `parseMocks`.
    mocks: parseMocks(mocksRaw ?? ""),
  };
}

/**
 * Read every prototype under the host-global prototypes dir into a
 * `PrototypeMeta[]`, skipping `_`-prefixed dirs (`_template` is a seed, not a
 * prototype) and dot-dirs. The dir name is the `name`; the display `title`
 * falls back to it when the HTML declares none.
 *
 * A malformed folder is listed, not hidden: its `problems` say what is wrong and
 * the gallery card shows them. Silently dropping it is how an author ends up
 * staring at a gallery that doesn't contain the thing they just wrote.
 *
 * Every folder read whole: the one-shot spelling, for a process that holds
 * nothing between two lists (the CLI). The server keeps one record per folder
 * fed by its watch (`server/internal/records.ts`) and composes the same metas
 * from them.
 */
export async function listPrototypeMetas(
  mount: Mount,
): Promise<PrototypeMeta[]> {
  const dirNames = await listPrototypeDirNames(mount);
  const nonTokenNames = nonTokenNamesOf(dirNames);
  const metas: PrototypeMeta[] = [];
  for (const dirName of dirNames) {
    const listing = await readFolderListing(mount, dirName);
    // Removed between the listing and its read: it no longer exists to list.
    if (listing === null) continue;
    const scanned = await scanPrototype(mount, dirName, listing, nonTokenNames);
    metas.push(metaOf(scanned, dirNames));
  }
  return metas;
}

/**
 * One prototype's `PrototypeMeta`, read from its own folder alone (the tree is
 * only listed, for the sibling names its validation checks against) — for a
 * caller that names one prototype and must not pay for reading every folder.
 * `null` when no such prototype is in the tree.
 */
export async function readPrototypeMeta(
  mount: Mount,
  name: string,
): Promise<PrototypeMeta | null> {
  const dirNames = await listPrototypeDirNames(mount);
  if (!dirNames.includes(name)) return null;
  const listing = await readFolderListing(mount, name);
  if (listing === null) return null;
  const scanned = await scanPrototype(
    mount,
    name,
    listing,
    nonTokenNamesOf(dirNames),
  );
  return metaOf(scanned, dirNames);
}

/**
 * One prototype's display title, read from its `index.html` alone — for a
 * caller that names a single prototype (an id in a task description) and must
 * not pay for validating the whole tree. `found: false` when no such folder or
 * entry file exists; the title falls back to `UNTITLED_PROTOTYPE` as the
 * lister's does.
 */
export async function readPrototypeTitle(
  mount: Mount,
  name: string,
): Promise<{ found: true; title: string } | { found: false }> {
  let entry;
  try {
    entry = relPath(name, PROTOTYPE_ENTRY_FILE);
  } catch (err) {
    // A name no folder can have (a `/` in it, `..`) names no prototype.
    if (err instanceof InvalidRelPathError) return { found: false };
    throw err;
  }
  const read = await readText(mount, entry);
  if (read.kind === "missing") return { found: false };
  const { title } = parseHtmlMeta(read.text);
  return { found: true, title: title === "" ? UNTITLED_PROTOTYPE : title };
}

/**
 * One prototype folder as its listing shows it — a stat and a listing, no
 * file read. Everything its meta derives from but the bytes: the files' sizes
 * and mtimes (the signature its `rev` is), its birth time and its subdirs.
 * `null` when there is no such folder (removed, or a file at that name).
 */
export interface FolderListing {
  createdAt: number;
  files: FolderFile[];
  /** Subdirs too: the signature skips them, but validation flags each one. */
  subdirs: string[];
  signature: string;
}

export async function readFolderListing(
  mount: Mount,
  dirName: string,
): Promise<FolderListing | null> {
  const dir = relPath(dirName);
  const dirStat = await mount.stat(dir);
  if (dirStat.kind === "missing" || dirStat.entry.kind !== "dir") return null;
  const listed = await mount.list(dir);
  if (listed.kind === "missing") return null;
  const files = folderFilesOf(listed.entries);
  return {
    createdAt: dirStat.entry.birthtimeMs,
    files,
    subdirs: listed.entries
      .filter((e) => e.kind === "dir" && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort(),
    signature: signatureOfFiles(files),
  };
}

/** Two listings with one key read the same folder — its scan still holds. */
export function listingKey(listing: FolderListing): string {
  return [listing.createdAt, listing.subdirs.join("/"), listing.signature].join(
    "\n",
  );
}

/**
 * One folder's meta, all but the problems that depend on which OTHER
 * prototypes exist ({@link metaOf} joins those in). What a long-lived lister
 * keeps per folder: a sibling minted or removed moves no folder's scan.
 *
 * `readable: false` is a folder that could not be read — its error is the
 * moment's, not the bytes', so a lister must not keep it.
 */
export type ScannedPrototype =
  | {
      readable: true;
      base: Omit<PrototypeMeta, "problems">;
      scan: PrototypeScan;
    }
  | {
      readable: false;
      base: Omit<PrototypeMeta, "problems">;
      problems: PrototypeProblem[];
    };

/**
 * Read, validate and parse one folder — the one place its bytes are read.
 * `nonTokenNames`: the sibling names a token lookup cannot answer
 * (`nonTokenNamesOf` over the tree's names; see `PrototypeScan`).
 */
export async function scanPrototype(
  mount: Mount,
  dirName: string,
  listing: FolderListing,
  nonTokenNames: readonly string[],
): Promise<ScannedPrototype> {
  const { files, createdAt, signature } = listing;
  const base = {
    name: dirName,
    rev: revOfSignature(signature),
    createdAt,
    modifiedAt: files.reduce((max, f) => Math.max(max, f.mtimeMs), createdAt),
    // NOT `dirName`: that is a minted id, which names nothing to a reader. See
    // UNTITLED_PROTOTYPE.
    title: UNTITLED_PROTOTYPE,
    blurb: "",
    viewport: DEFAULT_PROTOTYPE_VIEWPORT,
    mocks: { kind: "none" } as const,
    options: [],
  };

  // The listing is the folder as the caller last listed it — every file and
  // subdir its signature and `rev` describe — so only the bytes are read here,
  // never a second listing.
  let folder: Omit<PrototypeFolder, "siblings">;
  try {
    const fileNames = files.map((f) => f.name);
    folder = {
      dirName,
      subdirs: listing.subdirs,
      files: fileNames,
      texts: await readFolderTexts(mount, dirName, fileNames),
    };
  } catch (err) {
    // One unreadable folder must not take the whole gallery down with it — but
    // it is reported on its own card rather than swallowed.
    return {
      readable: false,
      base,
      problems: [{ path: "", detail: `could not be read: ${String(err)}` }],
    };
  }

  const scan = scanPrototypeFolder(folder, nonTokenNames);
  const html = folder.texts.get(PROTOTYPE_ENTRY_FILE);
  if (html === undefined) return { readable: true, base, scan };

  const parsed = parseHtmlMeta(html);
  return {
    readable: true,
    base: {
      ...base,
      title: parsed.title === "" ? UNTITLED_PROTOTYPE : parsed.title,
      blurb: parsed.blurb,
      viewport: parsed.viewport,
      mocks: parsed.mocks,
      // Valid options only; each broken line is already in the scan's
      // problems, from the same read (`scanPrototypeFolder` calls
      // `readPrototypeOptions` too).
      options: readPrototypeOptions(html).options,
    },
    scan,
  };
}

/**
 * A scanned folder's `PrototypeMeta` in a tree of `siblings` (every prototype
 * name, its own included) — no read: the references into siblings are joined
 * from the scan's tokens.
 */
export function metaOf(
  scanned: ScannedPrototype,
  siblings: readonly string[],
): PrototypeMeta {
  return {
    ...scanned.base,
    problems: scanned.readable
      ? problemsOf(scanned.scan, siblings)
      : scanned.problems,
  };
}
