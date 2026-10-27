import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { fingerprintFiles } from "@plugins/apps/plugins/prototypes/plugins/thumbnails/core";

// The demo's prototypes, as committed in `data/prototypes/` — a tree laid out
// like the app's data dir (`apps/prototypes`): one folder per prototype, plus
// `_`-prefixed record dirs (`_picks/<id>.json`) taken as they are. Each
// prototype folder may carry a `steps/` dir of history: `steps/v<N>.txt` (the
// version's subject on its first line, its body below) and `steps/v<N>/` (the
// files that version changes, laid over the one before). The folder's own
// files are `v0`; the newest step is what the folder holds now.
//
// Pure, over the tree's text in hand — the seed reads it from the worker
// bundle, the boot test, the thumbnails check and the render script from disk
// — so every reader agrees on what each version's folder holds, and so on its
// thumbnail's fingerprint.

/** The committed tree: path under `data/prototypes/` → the file's text. */
export type DemoPrototypeTree = Readonly<Record<string, string>>;

/** One version of a seeded prototype: its folder's files, and how it reads in the history. */
export interface DemoPrototypeVersion {
  /** 0 for the folder as first seeded. */
  n: number;
  /** The version's subject (`""` for `v0`, which the store words itself). */
  subject: string;
  body: string;
  /** The whole folder at this version: file name → text. */
  files: Readonly<Record<string, string>>;
  /** The files this version changed (for `v0`, every file). */
  changed: Readonly<Record<string, string>>;
}

export interface DemoPrototype {
  id: string;
  /** Oldest first; the last is what the folder holds now. */
  versions: readonly DemoPrototypeVersion[];
}

/** What the seed reads: the tree's text, and the committed thumbnail PNGs by fingerprint. */
export interface DemoPrototypeData {
  tree: DemoPrototypeTree;
  thumbnails: Readonly<Record<string, Uint8Array>>;
}

export interface DemoPrototypeSeed {
  prototypes: readonly DemoPrototype[];
  /** Every `_`-prefixed record file (`_picks/<id>.json`), path → text. */
  records: Readonly<Record<string, string>>;
}

const STEP_MESSAGE_RE = /^v([1-9]\d*)\.txt$/;
const STEP_DIR_RE = /^v([1-9]\d*)$/;

/**
 * The tree read into prototypes and their versions. Loud on anything the
 * layout does not allow — a folder name that is not a prototype id carrying
 * `demo` (every demo id does, so a leak is findable), a nested file, a step
 * with no message or no files, a gap in the step numbers, an empty tree — since
 * a seed that quietly dropped a file would show the demo something else.
 */
export function demoPrototypeSeed(tree: DemoPrototypeTree): DemoPrototypeSeed {
  const folders = new Map<
    string,
    {
      base: Record<string, string>;
      messages: Map<number, string>;
      overlays: Map<number, Record<string, string>>;
    }
  >();
  const records: Record<string, string> = {};
  for (const [path, text] of Object.entries(tree)) {
    const [top, ...rest] = path.split("/");
    if (top === undefined || rest.length === 0)
      throw new Error(
        `demo prototypes: "${path}" is not inside a prototype or record folder`,
      );
    if (top.startsWith("_")) {
      if (rest.length !== 1)
        throw new Error(`demo prototypes: "${path}" is nested in ${top}/`);
      records[path] = text;
      continue;
    }
    if (!protoIdKind.is(top) || !top.includes("demo"))
      throw new Error(
        `demo prototypes: folder "${top}" is not a prototype id carrying "demo" (proto-<epoch>-demoNN)`,
      );
    let folder = folders.get(top);
    if (folder === undefined) {
      folder = { base: {}, messages: new Map(), overlays: new Map() };
      folders.set(top, folder);
    }
    if (rest.length === 1) {
      folder.base[rest[0]!] = text;
      continue;
    }
    const [steps, step, file, ...deeper] = rest;
    if (steps !== "steps" || step === undefined || deeper.length > 0)
      throw new Error(
        `demo prototypes: "${path}" is nested — a prototype folder is flat, beside its steps/`,
      );
    const message = STEP_MESSAGE_RE.exec(step);
    if (file === undefined && message !== null) {
      folder.messages.set(Number(message[1]), text);
      continue;
    }
    const dir = STEP_DIR_RE.exec(step);
    if (file === undefined || dir === null)
      throw new Error(
        `demo prototypes: "${path}" is neither steps/v<N>.txt nor a file in steps/v<N>/`,
      );
    const n = Number(dir[1]);
    const overlay = folder.overlays.get(n) ?? {};
    overlay[file] = text;
    folder.overlays.set(n, overlay);
  }
  if (folders.size === 0)
    throw new Error("demo prototypes: the tree holds no prototype folder");

  const prototypes: DemoPrototype[] = [];
  for (const [id, { base, messages, overlays }] of [...folders].sort(
    ([a], [b]) => (a < b ? -1 : 1),
  )) {
    if (base["index.html"] === undefined)
      throw new Error(`demo prototypes: ${id} has no index.html`);
    const count = Math.max(0, ...messages.keys(), ...overlays.keys());
    const versions: DemoPrototypeVersion[] = [
      { n: 0, subject: "", body: "", files: base, changed: base },
    ];
    for (let n = 1; n <= count; n++) {
      const message = messages.get(n);
      const changed = overlays.get(n);
      if (message === undefined || changed === undefined)
        throw new Error(
          `demo prototypes: ${id}'s step v${n} needs both steps/v${n}.txt and files in steps/v${n}/`,
        );
      const [subject = "", ...body] = message.trim().split("\n");
      if (subject.trim() === "")
        throw new Error(
          `demo prototypes: ${id}'s steps/v${n}.txt has no subject line`,
        );
      versions.push({
        n,
        subject: subject.trim(),
        body: body.join("\n").trim(),
        files: { ...versions[n - 1]!.files, ...changed },
        changed,
      });
    }
    prototypes.push({ id, versions });
  }
  return { prototypes, records };
}

/**
 * The thumbnail cache key of a version's folder — the fingerprint the gallery
 * computes over the folder once it is seeded, so the committed PNG of that name
 * is the picture it looks up.
 */
export function demoVersionFingerprint(version: DemoPrototypeVersion): string {
  const encoder = new TextEncoder();
  return fingerprintFiles(
    Object.entries(version.files).map(([name, text]) => ({
      name,
      bytes: encoder.encode(text),
    })),
  );
}

/**
 * The seed's input from the files of the demo's `data/` folder, by path inside
 * it (`prototypes/<…>`, `thumbnails/<fingerprint>.png`) — how every host
 * process that is not the worker (the boot test, the thumbnails check, the
 * render script) reads the folder it lists off disk.
 */
export function demoPrototypeDataOf(
  files: Readonly<Record<string, Uint8Array>>,
): DemoPrototypeData {
  const decoder = new TextDecoder();
  const tree: Record<string, string> = {};
  const thumbnails: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(files)) {
    if (path.startsWith("prototypes/"))
      tree[path.slice("prototypes/".length)] = decoder.decode(bytes);
    else if (path.startsWith("thumbnails/") && path.endsWith(".png"))
      thumbnails[path.slice("thumbnails/".length, -".png".length)] = bytes;
    else
      throw new Error(
        `demo data: "${path}" is neither a prototype file nor a thumbnail`,
      );
  }
  return { tree, thumbnails };
}
