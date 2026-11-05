// The release half of the asset mirror's bundle: shared CLI machinery for
// `./equin release`, NOT a command (no default export, so the `cli`
// collected dir never registers it). A `cli/` barrel rather than `server/`:
// it loads the composition's prewarm registry by a computed path, and a
// `server/` barrel is in every backend's closure, which must stay digestable
// (`boot:closure-digestable`) — no backend ever pre-warms a release.
export { runAssetMirrorPrewarm } from "./internal/run-prewarm";
