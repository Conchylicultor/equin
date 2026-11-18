// Test helpers other suites reuse (only test code and `check/` may import a
// testing barrel): the release manifest's schema, which the stage-0 test
// (installer/cli) builds an older (v1) release.json with.
export { ReleaseManifest } from "../internal/assets";
