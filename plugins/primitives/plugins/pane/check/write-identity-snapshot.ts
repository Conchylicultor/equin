#!/usr/bin/env bun
/**
 * Regenerate the committed pane-identity manifest that `pane:identity-manifest`
 * compares against.
 *
 *   ./equin run plugins/primitives/plugins/pane/check/write-identity-snapshot.ts
 *
 * Then READ THE DIFF before committing. The manifest is not derived truth — it
 * is the reviewed RECORD of what every pane's id, segment, `appIndex` and parent
 * are, and regenerating it is how you assert those are the values you meant. A
 * line you did not expect is the bug the check exists to catch, and rewriting
 * the file is exactly what makes it stop being caught.
 *
 * Reads the WORKING TREE (the check reads the tree the cache is keyed on), so
 * the two agree on a clean checkout and the manifest is written from what you
 * are about to commit.
 */
import { relative } from "path";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  SNAPSHOT_FILE,
  scanPaneIdentities,
  writeIdentitySnapshot,
} from "./identity-manifest";

const root = await getWorktreeRoot();
const scan = await scanPaneIdentities();

if (!scan.ok) {
  // Refuse to write a manifest that covers fewer panes than the repo has — a
  // short manifest passes the check while guarding nothing.
  console.error(
    `Refusing to write ${relative(root, SNAPSHOT_FILE)}: ${scan.problems.length} ` +
      `pane(s) have no statically readable identity.\n` +
      scan.problems.map((p) => `  ${p}`).join("\n"),
  );
  process.exit(1);
}

writeIdentitySnapshot(scan.panes);
const indexes = scan.panes.filter((p) => p.appIndex).length;
process.stdout.write(
  `Wrote ${scan.panes.length} pane identities (${indexes} app index pane(s)) ` +
    `to ${relative(root, SNAPSHOT_FILE)}\n`,
);
