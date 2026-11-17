// The package-copy installer kind of infra/deps, host-only like the engine: a
// declaration of one npm package copied out of a workspace's node_modules
// (`npmPackageCopy`, in a feature's `deps/index.ts`), and the copy's package
// root and version once installed (which take a `Ready`).
export {
  npmPackageCopy,
  packageCopyDir,
  packageCopyVersion,
} from "./internal/package-copy";
export type { PackageCopySource } from "./internal/package-copy";
