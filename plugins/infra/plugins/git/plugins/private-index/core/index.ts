// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: it reads and renames
// a checkout's index through `node:fs`. Its two callers sit in a `core/`
// barrel (checks' tree hash) and a backend (worktree's primer), so `core/` is
// the one folder both may import. Never import it from `web/`.
export {
  copyIndex,
  publishRefreshedIndex,
  publishRefreshedIndexSync,
  writeIndexCopySync,
  type IndexPublish,
  type SeenIndex,
} from "./internal/private-index";
