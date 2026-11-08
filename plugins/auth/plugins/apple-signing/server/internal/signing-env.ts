import { getSecret } from "@plugins/infra/plugins/secrets/server";
import { getConfig } from "@plugins/config_v2/server";
import { CONFIG_FIELD_SECRETS } from "@plugins/fields/plugins/secret/plugins/config/core";
import { appleSigningConfig } from "../../shared/config";

async function readSecret(field: string): Promise<string> {
  const value = await getSecret({
    namespace: CONFIG_FIELD_SECRETS,
    key: `${appleSigningConfig.name}.${field}`,
  });
  return value ?? "";
}

/**
 * Assemble the `APPLE_*` env overlay the Tauri release consumes, reading the
 * three encrypted secrets and the three text config fields. Returns null when
 * ANY of the six credentials is missing/empty — release then proceeds unsigned
 * (graceful degradation, no hard failure).
 */
export async function getAppleSigningEnv(): Promise<Record<string, string> | null> {
  const [p12Cert, p12Password, ascApiKey] = await Promise.all([
    readSecret("p12Cert"),
    readSecret("p12Password"),
    readSecret("ascApiKey"),
  ]);

  const text = getConfig(appleSigningConfig);
  const signingIdentity = (text.signingIdentity ?? "").trim();
  const ascKeyId = (text.ascKeyId ?? "").trim();
  const ascIssuerId = (text.ascIssuerId ?? "").trim();

  if (
    !p12Cert ||
    !p12Password ||
    !ascApiKey ||
    !signingIdentity ||
    !ascKeyId ||
    !ascIssuerId
  ) {
    return null;
  }

  return {
    APPLE_CERTIFICATE: p12Cert,
    APPLE_CERTIFICATE_PASSWORD: p12Password,
    APPLE_SIGNING_IDENTITY: signingIdentity,
    APPLE_API_KEY_PEM: ascApiKey,
    APPLE_API_KEY_ID: ascKeyId,
    APPLE_API_ISSUER_ID: ascIssuerId,
  };
}
