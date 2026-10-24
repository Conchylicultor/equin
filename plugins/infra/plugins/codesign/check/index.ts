import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  configuredValidTo,
  machineHost,
  readConfiguredValue,
  readLocalIdentity,
  resolveConfigured,
  RESET_HINT,
} from "../deps";

const DAY_MS = 24 * 60 * 60_000;
/** How far ahead an expiry is reported. */
const EXPIRY_WARNING_DAYS = 30;

function expiryVerdict(
  what: string,
  validTo: Date,
  renew: string,
): CheckResult {
  const days = Math.floor((validTo.getTime() - Date.now()) / DAY_MS);
  if (days >= EXPIRY_WARNING_DAYS) return { ok: true };
  return {
    ok: false,
    message:
      days < 0
        ? `${what} expired on ${validTo.toISOString().slice(0, 10)}`
        : `${what} expires in ${days} day${days === 1 ? "" : "s"} (${validTo.toISOString().slice(0, 10)})`,
    hint: renew,
  };
}

/**
 * The machine's code-signing identity is usable and not about to expire: a
 * configured identity resolves to exactly one valid keychain identity, and the
 * certificate it (or the local identity) signs with is good for 30 more days.
 * A local identity not created yet passes — the next gateway build creates it.
 *
 * Host-scoped: it is about this machine's keychain and data root, not the
 * tree, so only a standalone `./equin check` runs it and a build never fails
 * on it.
 */
const identity: Check = {
  id: "codesign:identity",
  description:
    "this machine's code-signing identity resolves (a configured one to exactly one valid keychain identity) and its certificate is valid for 30 more days",
  scope: "host",
  // Reads the keychain and the data root, which no signature can cover.
  cacheSignature: () => null,
  async run() {
    const host = machineHost();
    if (host.platform !== "darwin") return { ok: true };
    const configured = readConfiguredValue(host);
    if (configured !== null) {
      const resolved = await resolveConfigured(configured, host).catch(
        (err: unknown) => {
          if (err instanceof Error) return err;
          throw err;
        },
      );
      if (resolved instanceof Error) {
        return {
          ok: false,
          message: resolved.message,
          hint: `Fix ${configured.from}, or remove it to sign with this machine's local identity (a new signer: macOS asks again for the gateway's permissions).`,
        };
      }
      return expiryVerdict(
        `the configured code-signing identity "${resolved.label}"`,
        await configuredValidTo(resolved, host),
        "Renew the certificate (Xcode → Settings → Accounts, or developer.apple.com), then rebuild the gateway (`./equin start`).",
      );
    }
    const local = readLocalIdentity(host);
    if (local.kind === "absent") return { ok: true };
    if (local.kind === "partial") {
      return {
        ok: false,
        message: `the local code-signing identity is incomplete: ${local.missing} is missing`,
        hint: `${RESET_HINT}.`,
      };
    }
    return expiryVerdict(
      `the local code-signing certificate (${local.identity.sha1})`,
      local.identity.validTo,
      `${RESET_HINT}.`,
    );
  },
};

export default [identity];
