import { webDistDir } from "@plugins/infra/plugins/paths/server";
import { readDistTrailer } from "./dist-trailers";

// The commit the frontend bundle this backend serves was BUILT FROM, read from
// `dist/.build-commit` FRESH on every call — same rule, and same reason, as
// `getServerGraphHash` beside it: `./equin build` swaps the `dist` symlink
// before it restarts this backend, so a value memoized at process start would
// disagree with the served bundle for the whole swap→restart window.
//
// The build stamps this with the commit it sampled BEFORE reading a single
// source file, so it names the tree these bytes actually came from — not
// whatever the checkout moved to while the compile ran. That distinction is the
// whole point: a `git rev-parse HEAD` taken after the compile once made a stale
// frontend read as current and cost a catch-up build.
//
// THIS PROCESS's dist (`webDistDir()`, from its runtime namespace): a process
// with none — a CLI — throws here. It reads a namespace's dist by naming it
// (`readDistTrailer(worktreeArtifacts.webDist(ns), …)`).
export async function getServerCommit(): Promise<string | null> {
  return readDistTrailer(webDistDir(), ".build-commit");
}
