// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: it takes flock(2)
// locks over `bun:ffi`. It is `core/` rather than `server/` because its
// readers sit below every server barrel — `server-core`'s exec boot — and a
// `server/` barrel's plugin definition would close a cycle through it. Never
// import it from `web/`.
export {
  holdTreeRead,
  treeLockPath,
  withTreeWrite,
} from "./internal/tree-lock";
