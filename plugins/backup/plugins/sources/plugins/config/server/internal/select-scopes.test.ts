/**
 * Which config subtrees the backup takes: the persistent namespaces only.
 *
 * Run: `./equin test plugins/backup/plugins/sources/plugins/config`
 */

import { describe, test, expect } from "bun:test";
import {
  MAIN_WORKTREE_NAME,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import {
  classifyScopes,
  describeLeftOut,
  backedUpScopes,
} from "./select-scopes";

/** Namespaces with a `composition.json` marker on disk. */
const MARKED = new Set(["sonata", "website.att-1794490520-fdd74g"]);
const hasMarker = (ns: Namespace) => Promise.resolve(MARKED.has(ns));

const dirs = (...names: string[]) =>
  names.map((name) => ({ name, isDirectory: true }));

describe("config scopes", () => {
  test("every subtree but a worktree's is copied; worktrees are never touched", async () => {
    const classified = await classifyScopes(
      dirs(
        MAIN_WORKTREE_NAME,
        "sonata",
        // The subtree a reap removed mid-copy (report-1794452517-7v3y31).
        "att-1794191531-5grztv",
        "att-1794505470-f7fnnc",
        "website.att-1794490520-fdd74g",
        "jovial-bell-b5af86",
      ),
      hasMarker,
    );
    expect(backedUpScopes(classified).map((s) => s.name)).toEqual([
      MAIN_WORKTREE_NAME,
      "sonata",
      "jovial-bell-b5af86",
    ]);
    expect(describeLeftOut(classified)).toEqual([
      {
        label: "3 worktree config copies",
        detail: "disposable, reaped with their checkout, never backed up",
        count: 3,
      },
    ]);
  });

  test("a top-level file is never a namespace: Finder's .DS_Store is left out by rule, any other file is copied", async () => {
    // Finder's .DS_Store at the top of the config dir was classified as an
    // orphan namespace and globbed into as a directory: ENOTDIR, Config left
    // out of four nightly backups (report-1794452517-7v3y31).
    const classified = await classifyScopes(
      [
        ...dirs(MAIN_WORKTREE_NAME),
        { name: ".DS_Store", isDirectory: false },
        { name: "notes.txt", isDirectory: false },
        // Any directory is still a namespace subtree (here an orphan).
        { name: "x", isDirectory: true },
      ],
      hasMarker,
    );
    expect(classified).toEqual([
      { name: MAIN_WORKTREE_NAME, kind: "main" },
      { name: ".DS_Store", kind: "ignored" },
      { name: "notes.txt", kind: "loose-file" },
      { name: "x", kind: "orphan" },
    ]);
    expect(backedUpScopes(classified).map((s) => s.name)).toEqual([
      MAIN_WORKTREE_NAME,
      "notes.txt",
      "x",
    ]);
    expect(describeLeftOut(classified)).toEqual([
      {
        label: ".DS_Store",
        detail:
          "Finder's folder view settings, written whenever the folder is opened in Finder — no config",
        count: 1,
      },
    ]);
  });
});
