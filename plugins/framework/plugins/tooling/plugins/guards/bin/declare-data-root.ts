import {
  DataRootSplitError,
  declareDataRootLayoutSync,
} from "@plugins/infra/plugins/paths/core";

// A hook is the root of its own process tree: Claude Code starts it, and Claude
// Code may hold an environment from before a migration (or none), so the hook
// decides the data root from the disk before anything reads a path (infra/paths
// CLAUDE.md, § The data root). Imported first by `./hook` and `./stop-hook`,
// which the repo-free bootstrap loads dynamically. A split install stays
// undeclared, so only a guard that reads a path throws it — not every hook.
try {
  declareDataRootLayoutSync();
} catch (err) {
  if (!(err instanceof DataRootSplitError)) throw err;
}
