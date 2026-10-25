// Code signing for the code this machine builds (the gateway, the equin app
// bundle), so macOS keys their permission grants to a stable signer instead of
// a per-build hash, and the bundle's registration with LaunchServices.
// Host-only, like every `deps/` barrel. `rcodesign` is collected into infra/deps'
// registry through the `default` array (Settings → Dependencies).
import { rcodesign } from "./internal/rcodesign";

export { rcodesign } from "./internal/rcodesign";
export {
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
export {
  codeSignature,
  isSignedBy,
  signBinary,
  signBundle,
  signedByRequirement,
} from "./internal/sign";
export type { SignOutcome } from "./internal/sign";
export { registerApp } from "./internal/launch-services";
export { machineHost } from "./internal/host";
export type {
  CodesignHost,
  CommandResult,
  RcodesignTool,
} from "./internal/host";

export default [rcodesign];
