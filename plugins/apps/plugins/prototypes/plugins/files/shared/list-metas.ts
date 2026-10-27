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
  readPrototypeOptions,
  validatePrototypeFolder,
  type MocksDeclaration,
  type PrototypeFolder,
  type PrototypeMeta,
  type PrototypeProblem,
  type PrototypeViewport,
} from "../core";
import { listPrototypeDirNames, readPrototypeFolder } from "./read-folder";
import {
  readFolderFiles,
  revOfSignature,
  signatureOfFiles,
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
 */
export async function listPrototypeMetas(
  mount: Mount,
): Promise<PrototypeMeta[]> {
  const dirNames = await listPrototypeDirNames(mount);

  const metas: PrototypeMeta[] = [];
  for (const dirName of dirNames) {
    const meta = await readMeta(mount, dirName, dirNames);
    // Removed between the listing and its read: it no longer exists to list.
    if (meta !== null) metas.push(meta);
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
  return await readMeta(mount, name, dirNames);
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

async function readMeta(
  mount: Mount,
  dirName: string,
  siblings: string[],
): Promise<PrototypeMeta | null> {
  const dirStat = await mount.stat(relPath(dirName));
  if (dirStat.kind === "missing") return null;
  const files = await readFolderFiles(mount, dirName);
  if (files === null) return null;
  const createdAt = dirStat.entry.birthtimeMs;
  const base = {
    name: dirName,
    rev: revOfSignature(signatureOfFiles(files)),
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

  let folder: PrototypeFolder;
  try {
    folder = await readPrototypeFolder(mount, dirName, siblings);
  } catch (err) {
    // One unreadable folder must not take the whole gallery down with it — but
    // it is reported on its own card rather than swallowed.
    return {
      ...base,
      problems: [{ path: "", detail: `could not be read: ${String(err)}` }],
    };
  }

  const problems: PrototypeProblem[] = validatePrototypeFolder(folder);
  const html = folder.texts.get(PROTOTYPE_ENTRY_FILE);
  if (html === undefined) return { ...base, problems };

  const parsed = parseHtmlMeta(html);
  return {
    ...base,
    title: parsed.title === "" ? UNTITLED_PROTOTYPE : parsed.title,
    blurb: parsed.blurb,
    viewport: parsed.viewport,
    mocks: parsed.mocks,
    // Valid options only; each broken line is already in `problems`, from the
    // same read (`validatePrototypeFolder` calls `readPrototypeOptions` too).
    options: readPrototypeOptions(html).options,
    problems,
  };
}
