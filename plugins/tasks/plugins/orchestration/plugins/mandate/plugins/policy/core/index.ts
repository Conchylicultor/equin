export {
  defineCapability,
  GRANT_SCOPES,
  mandatePolicy,
  scopeKey,
} from "./internal/define";
export type {
  Capability,
  CapabilityDef,
  Grant,
  GrantScope,
  MandatePolicy,
  ScopedGrants,
} from "./internal/define";
export { defineMandate, MandateIdSchema } from "./internal/named";
export type { MandateId, MandateRef } from "./internal/named";
