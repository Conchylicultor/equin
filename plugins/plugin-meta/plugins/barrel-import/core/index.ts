export {
  BARREL_STUB_WORKTREE,
  registerBarrelStubs,
  importBarrel,
  setPreBarrelImportGuard,
} from "./internal/stubs";
export {
  AUTO_STUB_PACKAGES,
  AUTO_STUB_CSS,
  type AutoStubEntry,
} from "./internal/auto-stub-packages";
export { barrelLoadInputs, BarrelLoadReadError } from "./internal/load-guard";
