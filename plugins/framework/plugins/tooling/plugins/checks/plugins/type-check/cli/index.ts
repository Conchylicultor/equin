// A `cli/` barrel that declares no command: the cross-plugin entry point for a
// `./equin` verb that type-checks the working tree as it is (the build's
// `--skip-checks` path, the backstop). Reading the tree loads the TypeScript
// compiler and the check runner, so it is published here — a host process's
// barrel — never by `../server`, which every backend loads.
export { readTypeCheckTree } from "./read-tree";
