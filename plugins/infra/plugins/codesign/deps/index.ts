// Code signing for the binaries this machine builds (the gateway), so macOS
// keys their permission grants to a stable signer instead of a per-build hash.
// Host-only, like every `deps/` barrel. `rcodesign` is collected into infra/deps'
// registry through the `default` array (Settings → Dependencies).
import { rcodesign } from "./internal/rcodesign";

export { rcodesign } from "./internal/rcodesign";
export {
  CODESIGN_IDENTITY_ENV,
  configuredIdentityFile,
  configuredValidTo,
  LOCAL_IDENTITY_NAME,
  localIdentityPaths,
  readConfiguredValue,
  readLocalIdentity,
  resolveConfigured,
  resolveSigningIdentity,
  RESET_HINT,
} from "./internal/identity";
export type {
  ConfiguredValue,
  LocalIdentityState,
  SigningIdentity,
} from "./internal/identity";
export { isSignedBy, signBinary, signedByRequirement } from "./internal/sign";
export type { SignOutcome } from "./internal/sign";
export { machineHost } from "./internal/host";
export type { CodesignHost, CommandResult } from "./internal/host";

export default [rcodesign];
