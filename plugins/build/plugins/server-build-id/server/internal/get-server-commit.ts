import { webDistDir } from "@plugins/infra/plugins/paths/server";
import { readFileSync } from "node:fs";

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
export function getServerCommit(): string | null {
  try {
    return readFileSync(`${webDistDir()}/.build-commit`, "utf8").trim() || null;
    // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- best-effort optional dotfile read; a missing/unreadable .build-commit (before the first build, or a build whose git could not answer) legitimately means "commit unknown" → the caller turns it into an explicit unresolved(reason), never a fake sha
  } catch {
    return null;
  }
}
