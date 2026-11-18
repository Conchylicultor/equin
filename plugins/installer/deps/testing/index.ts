// Test helpers other suites reuse (only test code and `check/` may import a
// testing barrel): the bashes every install.sh test runs the script under.
export { installShBashes } from "../internal/install-sh-bashes";
export type { InstallShBash } from "../internal/install-sh-bashes";
