import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

// Upload a Developer ID `.p12` (base64) + its password. The server persists the
// cert + password as secret config fields and attempts to derive the signing
// identity (certificate CN) via openssl. `signingIdentity` is null when the CN
// could not be parsed — the UI then offers manual entry.
export const setAppleCertificateEndpoint = defineEndpoint({
  route: "POST /api/apple-signing/certificate",
  agentReverted: true,
  body: z.object({
    p12Base64: z.string(),
    password: z.string(),
  }),
  response: z.object({
    signingIdentity: z.string().nullable(),
  }),
});
