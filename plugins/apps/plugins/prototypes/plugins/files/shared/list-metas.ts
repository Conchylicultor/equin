// Reading the whole prototypes tree into `PrototypeMeta[]` — THE one
// implementation, for the two processes that need it.
//
// `shared/`, not `server/`, for the reason `read-folder.ts` and `mint.ts` are:
// `./equin prototype list` must answer with no backend running, and a CLI
// process cannot import a server barrel's boot-time machinery to do it. Nothing
// in here was ever server-specific — it reads the data dir and parses HTML — so
// the move is a relocation, not a fork. `server/internal/list.ts` re-exports it,
// which is why the server barrel's API is unchanged.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeHtmlText,
  readHtmlAttr,
} from "@plugins/infra/plugins/html-decode/core";
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
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";

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
 * Streaming-parsed with `HTMLRewriter`, which hands back RAW markup — every
 * value it yields is decoded exactly once through `html-decode` (attributes via
 * `readHtmlAttr`, text accumulated first and decoded at the end, because a
 * character reference can straddle two chunks).
 *
 * First occurrence wins for each tag: a `<title>` further down the document
 * (inside an inline `<svg>`, say) is not the document's title.
 */
async function parseHtmlMeta(html: string): Promise<HtmlMeta> {
  const titleChunks: string[] = [];
  let titleDone = false;
  let blurbRaw: string | undefined;
  let viewportRaw: string | undefined;
  let mocksRaw: string | undefined;

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(chunk) {
        if (titleDone) return;
        titleChunks.push(chunk.text);
        if (chunk.lastInTextNode) titleDone = true;
      },
    })
    .on("meta", {
      element(el) {
        const name = readHtmlAttr(el, "name");
        if (name === "description") {
          blurbRaw ??= readHtmlAttr(el, "content");
        } else if (name === "prototype-viewport") {
          viewportRaw ??= readHtmlAttr(el, "content");
        } else if (name === "mocks") {
          mocksRaw ??= readHtmlAttr(el, "content");
        }
      },
    });

  // The rewriter only runs its handlers as the body is consumed.
  await rewriter.transform(new Response(html)).text();

  // An unreadable size is also a `problems[]` entry, from the same parser
  // (`validatePrototypeFolder`); here it reads as the default.
  const viewport = parseViewport(viewportRaw);

  return {
    title: decodeHtmlText(titleChunks.join("")).trim(),
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
export async function listPrototypeMetas(): Promise<PrototypeMeta[]> {
  const dirNames = await listPrototypeDirNames(prototypesDir.path);

  const metas: PrototypeMeta[] = [];
  for (const dirName of dirNames) {
    const meta = await readMeta(dirName, dirNames);
    // Removed between the listing and its read: it no longer exists to list.
    if (meta !== null) metas.push(meta);
  }
  return metas;
}

/**
 * One prototype's display title, read from its `index.html` alone — for a
 * caller that names a single prototype (an id in a task description) and must
 * not pay for validating the whole tree. `found: false` when no such folder or
 * entry file exists; the title falls back to `UNTITLED_PROTOTYPE` as the
 * lister's does.
 */
export async function readPrototypeTitle(
  name: string,
): Promise<{ found: true; title: string } | { found: false }> {
  let html: string;
  try {
    html = await readFile(
      join(prototypesDir.path, name, PROTOTYPE_ENTRY_FILE),
      "utf8",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { found: false };
    }
    throw err;
  }
  const { title } = await parseHtmlMeta(html);
  return { found: true, title: title === "" ? UNTITLED_PROTOTYPE : title };
}

async function readMeta(
  dirName: string,
  siblings: string[],
): Promise<PrototypeMeta | null> {
  const dirAbs = join(prototypesDir.path, dirName);
  let dirStat;
  try {
    dirStat = await stat(dirAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const files = await readFolderFiles(dirAbs);
  if (files === null) return null;
  const createdAt = dirStat.birthtimeMs;
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
    folder = await readPrototypeFolder(prototypesDir.path, dirName, siblings);
  } catch (err) {
    // One unreadable folder must not take the whole gallery down with it — but
    // it is reported on its own card rather than swallowed.
    return {
      ...base,
      problems: [{ path: "", detail: `could not be read: ${String(err)}` }],
    };
  }

  const problems: PrototypeProblem[] = await validatePrototypeFolder(folder);
  const html = folder.texts.get(PROTOTYPE_ENTRY_FILE);
  if (html === undefined) return { ...base, problems };

  const parsed = await parseHtmlMeta(html);
  return {
    ...base,
    title: parsed.title === "" ? UNTITLED_PROTOTYPE : parsed.title,
    blurb: parsed.blurb,
    viewport: parsed.viewport,
    mocks: parsed.mocks,
    // Valid options only; each broken line is already in `problems`, from the
    // same read (`validatePrototypeFolder` calls `readPrototypeOptions` too).
    options: (await readPrototypeOptions(html)).options,
    problems,
  };
}
