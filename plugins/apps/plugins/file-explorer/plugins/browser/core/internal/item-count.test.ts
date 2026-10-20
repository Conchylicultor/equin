import { describe, expect, test } from "bun:test";
import type { HostFsEntry } from "@plugins/infra/plugins/host-fs/core";
import {
  itemCount,
  type EntryFilter,
  type FolderRefusal,
  type ListedFolder,
} from "./item-count";

const DIR = "~/src";

const entry = (name: string): HostFsEntry => ({
  name,
  kind: "file",
  size: 1,
  mtimeMs: 0,
  hidden: name.startsWith("."),
});
const listing = (...names: string[]): ListedFolder => ({
  kind: "listed",
  entries: names.map(entry),
});
const refused = (
  code: FolderRefusal["code"],
  message = `${code}: /x`,
): FolderRefusal => ({ kind: "refused", code, message });

const showAll: EntryFilter = () => true;
const hideDotfiles: EntryFilter = (e) => !e.hidden;
const hideIgnored: EntryFilter = (_e, path) => !path.endsWith("/dist");

describe("itemCount", () => {
  test("a listed folder counts its listing, never its peek", () => {
    const peek = {
      kind: "ok" as const,
      path: "/srv/src",
      children: [{ name: "stale", hidden: false }],
    };
    expect(
      itemCount(DIR, listing("a", ".b", "dist"), peek, hideDotfiles),
    ).toEqual({ kind: "count", n: 2 });
  });

  test("a peeked folder applies Show hidden files and the lens rules by path", () => {
    const peek = {
      kind: "ok" as const,
      path: "/srv/src",
      children: [
        { name: "a", hidden: false },
        { name: ".git", hidden: true },
        { name: "dist", hidden: false },
      ],
    };
    expect(itemCount(DIR, undefined, peek, showAll)).toEqual({
      kind: "count",
      n: 3,
    });
    expect(itemCount(DIR, undefined, peek, hideDotfiles)).toEqual({
      kind: "count",
      n: 2,
    });
    expect(itemCount(DIR, undefined, peek, hideIgnored)).toEqual({
      kind: "count",
      n: 2,
    });
  });

  test("an empty folder is a real 0; a refusal never is", () => {
    expect(
      itemCount(
        DIR,
        undefined,
        { kind: "ok", path: "/x", children: [] },
        showAll,
      ),
    ).toEqual({ kind: "count", n: 0 });
    expect(itemCount(DIR, undefined, refused("denied"), showAll)).toEqual({
      kind: "denied",
    });
    expect(itemCount(DIR, undefined, refused("missing"), showAll)).toEqual({
      kind: "gone",
    });
    expect(itemCount(DIR, undefined, refused("not-a-dir"), showAll)).toEqual({
      kind: "gone",
    });
    expect(
      itemCount(
        DIR,
        undefined,
        refused("unreadable-archive", "This archive is encrypted: /a.zip"),
        showAll,
      ),
    ).toEqual({
      kind: "unreadable",
      message: "This archive is encrypted: /a.zip",
    });
  });

  test("a folder with too many names reports its raw total", () => {
    expect(
      itemCount(
        DIR,
        undefined,
        { kind: "too-many", path: "/x", total: 12_345 },
        showAll,
      ),
    ).toEqual({ kind: "many", total: 12_345 });
  });

  test("a folder row that became an archive file is gone", () => {
    expect(
      itemCount(DIR, undefined, { kind: "archive", path: "/x" }, showAll),
    ).toEqual({ kind: "gone" });
  });

  test("a refused listing is its refusal; neither answered is loading", () => {
    expect(itemCount(DIR, refused("denied"), undefined, showAll)).toEqual({
      kind: "denied",
    });
    expect(itemCount(DIR, undefined, undefined, showAll)).toEqual({
      kind: "loading",
    });
  });
});
