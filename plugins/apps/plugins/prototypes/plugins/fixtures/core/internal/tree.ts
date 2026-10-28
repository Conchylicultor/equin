import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { prototypeTagIdKind } from "@plugins/apps/plugins/prototypes/plugins/state/core";
import { fingerprintFiles } from "@plugins/apps/plugins/prototypes/plugins/thumbnails/core";

// A prototype fixture: some prototypes with their history, laid out like the
// app's data dir (`apps/prototypes`) — one folder per prototype, plus
// `_`-prefixed record dirs (`_picks/<id>.json`) taken as they are. Each
// prototype folder may carry a `steps/` dir of history: `steps/v<N>.txt` (the
// version's subject on its first line, its body below) and `steps/v<N>/` (the
// files that version changes, laid over the one before). The folder's own
// files are `v0`; the newest step is what the folder holds now.
//
// Pure, over the tree's text in hand — a worker reads it from its bundle, a
// test, a check or a script from disk — so every reader agrees on what each
// version's folder holds, and so on its thumbnail's fingerprint.

/** The tree: path under the fixture's `prototypes/` → the file's text. */
export type PrototypeTreeFixture = Readonly<Record<string, string>>;

/** One version of a fixture prototype: its folder's files, and how it reads in the history. */
export interface PrototypeFixtureVersion {
  /** 0 for the folder as first written. */
  n: number;
  /** The version's subject (`""` for `v0`, which the store words itself). */
  subject: string;
  body: string;
  /** The whole folder at this version: file name → text. */
  files: Readonly<Record<string, string>>;
  /** The files this version changed (for `v0`, every file). */
  changed: Readonly<Record<string, string>>;
}

export interface PrototypeFixtureFolder {
  /** The folder name: a prototype id. */
  id: string;
  /** Oldest first; the last is what the folder holds now. */
  versions: readonly PrototypeFixtureVersion[];
}

export interface ParsedPrototypeTree {
  /** Sorted by id. */
  prototypes: readonly PrototypeFixtureFolder[];
  /** Every `_`-prefixed record file (`_picks/<id>.json`), path → text. */
  records: Readonly<Record<string, string>>;
}

/** A fixture's files: the tree's text, and its committed thumbnail PNGs by fingerprint. */
export interface PrototypeFixtureData {
  tree: PrototypeTreeFixture;
  thumbnails: Readonly<Record<string, Uint8Array>>;
}

/** A gallery tag of the fixture, and the prototypes carrying it (a prototype carries at most one). */
export interface PrototypeFixtureTag {
  /** A prototype tag id (`prtag-…`). */
  id: string;
  name: string;
  color: string | null;
  carriers: readonly string[];
}

/** What a fixture writer is handed: the files, plus the gallery rows about them. */
export interface PrototypeFixture extends PrototypeFixtureData {
  /** In gallery order. */
  tags?: readonly PrototypeFixtureTag[];
  /** The prototypes pinned to the top of the gallery. */
  pinned?: readonly string[];
}

/** One `prototype_state` row a fixture asks for. */
export interface PrototypeFixtureState {
  id: string;
  tagId: string | null;
  pinned: boolean;
}

const STEP_MESSAGE_RE = /^v([1-9]\d*)\.txt$/;
const STEP_DIR_RE = /^v([1-9]\d*)$/;

/**
 * The tree read into prototypes and their versions. Loud on anything the
 * layout does not allow — a folder name that is not a prototype id, a nested
 * file, a step with no message or no files, a gap in the step numbers, a
 * folder with no `index.html`, an empty tree — since a writer that quietly
 * dropped a file would show something else.
 */
export function parsePrototypeTree(
  tree: PrototypeTreeFixture,
): ParsedPrototypeTree {
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
        `prototype fixture: "${path}" is not inside a prototype or record folder`,
      );
    if (top.startsWith("_")) {
      if (rest.length !== 1)
        throw new Error(`prototype fixture: "${path}" is nested in ${top}/`);
      records[path] = text;
      continue;
    }
    if (!protoIdKind.is(top))
      throw new Error(
        `prototype fixture: folder "${top}" is not a prototype id (proto-<epoch>-<6 base36>)`,
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
        `prototype fixture: "${path}" is nested — a prototype folder is flat, beside its steps/`,
      );
    const message = STEP_MESSAGE_RE.exec(step);
    if (file === undefined && message !== null) {
      folder.messages.set(Number(message[1]), text);
      continue;
    }
    const dir = STEP_DIR_RE.exec(step);
    if (file === undefined || dir === null)
      throw new Error(
        `prototype fixture: "${path}" is neither steps/v<N>.txt nor a file in steps/v<N>/`,
      );
    const n = Number(dir[1]);
    const overlay = folder.overlays.get(n) ?? {};
    overlay[file] = text;
    folder.overlays.set(n, overlay);
  }
  if (folders.size === 0)
    throw new Error("prototype fixture: the tree holds no prototype folder");

  const prototypes: PrototypeFixtureFolder[] = [];
  for (const [id, { base, messages, overlays }] of [...folders].sort(
    ([a], [b]) => (a < b ? -1 : 1),
  )) {
    if (base["index.html"] === undefined)
      throw new Error(`prototype fixture: ${id} has no index.html`);
    const count = Math.max(0, ...messages.keys(), ...overlays.keys());
    const versions: PrototypeFixtureVersion[] = [
      { n: 0, subject: "", body: "", files: base, changed: base },
    ];
    for (let n = 1; n <= count; n++) {
      const message = messages.get(n);
      const changed = overlays.get(n);
      if (message === undefined || changed === undefined)
        throw new Error(
          `prototype fixture: ${id}'s step v${n} needs both steps/v${n}.txt and files in steps/v${n}/`,
        );
      const [subject = "", ...body] = message.trim().split("\n");
      if (subject.trim() === "")
        throw new Error(
          `prototype fixture: ${id}'s steps/v${n}.txt has no subject line`,
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
 * computes over the folder once it is written, so the committed PNG of that
 * name is the picture it looks up.
 */
export function prototypeFixtureVersionFingerprint(
  version: PrototypeFixtureVersion,
): string {
  const encoder = new TextEncoder();
  return fingerprintFiles(
    Object.entries(version.files).map(([name, text]) => ({
      name,
      bytes: encoder.encode(text),
    })),
  );
}

/** A fixture's thumbnails against its versions: what is missing, what is unused. */
export interface PrototypeFixtureThumbnailsAudit {
  /** Every version's fingerprint → `<id> v<N>`. */
  wanted: ReadonlyMap<string, string>;
  /** `<id> v<N> (<fingerprint>.png)`, for each version with no PNG. */
  missing: readonly string[];
  /** `<fingerprint>.png`, for each PNG no version names. */
  unused: readonly string[];
}

/**
 * Which versions of the tree have no committed thumbnail, and which committed
 * thumbnails no version names — what the writer refuses, the check reports and
 * the render script fixes.
 */
export function auditPrototypeFixtureThumbnails(
  parsed: ParsedPrototypeTree,
  thumbnails: PrototypeFixtureData["thumbnails"],
): PrototypeFixtureThumbnailsAudit {
  const wanted = new Map<string, string>();
  const missing: string[] = [];
  for (const p of parsed.prototypes)
    for (const v of p.versions) {
      const key = prototypeFixtureVersionFingerprint(v);
      wanted.set(key, `${p.id} v${v.n}`);
      if (thumbnails[key] === undefined)
        missing.push(`${p.id} v${v.n} (${key}.png)`);
    }
  const unused = Object.keys(thumbnails)
    .filter((key) => !wanted.has(key))
    .map((key) => `${key}.png`);
  return { wanted, missing, unused };
}

/**
 * The `prototype_state` rows the fixture's tags and pins ask for, one per
 * prototype that carries a tag or is pinned. Loud on a tag id that is not a
 * prototype tag id, a carrier or pin naming a prototype the tree does not
 * hold, and a prototype carrying two tags.
 */
export function prototypeFixtureStates(
  parsed: ParsedPrototypeTree,
  fixture: Pick<PrototypeFixture, "tags" | "pinned">,
): PrototypeFixtureState[] {
  const ids = new Set(parsed.prototypes.map((p) => p.id));
  const states = new Map<string, PrototypeFixtureState>();
  const stateOf = (id: string, why: string): PrototypeFixtureState => {
    if (!ids.has(id))
      throw new Error(
        `prototype fixture: ${why} names ${id}, which the tree does not hold`,
      );
    let state = states.get(id);
    if (state === undefined) {
      state = { id, tagId: null, pinned: false };
      states.set(id, state);
    }
    return state;
  };
  for (const tag of fixture.tags ?? []) {
    if (!prototypeTagIdKind.is(tag.id))
      throw new Error(
        `prototype fixture: tag "${tag.id}" is not a prototype tag id (prtag-<epoch>-<6 base36>)`,
      );
    for (const id of tag.carriers) {
      const state = stateOf(id, `tag ${tag.id}`);
      if (state.tagId !== null)
        throw new Error(
          `prototype fixture: ${id} carries two tags (${state.tagId}, ${tag.id}) — a prototype carries at most one`,
        );
      state.tagId = tag.id;
    }
  }
  for (const id of fixture.pinned ?? []) stateOf(id, "pinned").pinned = true;
  return [...states.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * A fixture's files from a folder holding `prototypes/<…>` and
 * `thumbnails/<fingerprint>.png`, by path inside it — how a host process that
 * reads the folder off disk (a test, the check, the render script) hands it
 * over. Anything else in the listing is loud.
 */
export function prototypeFixtureDataOf(
  files: Readonly<Record<string, Uint8Array>>,
): PrototypeFixtureData {
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
        `prototype fixture: "${path}" is neither a prototype file nor a thumbnail`,
      );
  }
  return { tree, thumbnails };
}
