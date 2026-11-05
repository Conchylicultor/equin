// A slice of the app's server registry booted as a portable host under
// `bun test`: the graph (`registryClosureOf` / `portableClosureOf`) and what a
// host without the computer boots beside it (`withPortableHost`).
export {
  portableClosureOf,
  registryClosureOf,
  withPortableHost,
} from "./portable-host";
