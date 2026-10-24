import type { CliAction } from "@plugins/framework/plugins/cli/core";
import {
  configuredValidTo,
  machineHost,
  readConfiguredValue,
  readLocalIdentity,
  resolveConfigured,
  RESET_HINT,
} from "../../deps";

/** `./equin codesign status` — read-only: never creates the local identity. */
const run: CliAction<[], object> = async () => {
  const host = machineHost();
  if (host.platform !== "darwin") {
    console.log(`Nothing is code-signed on ${host.platform}.`);
    return;
  }
  const configured = readConfiguredValue(host);
  if (configured !== null) {
    const identity = await resolveConfigured(configured, host);
    const validTo = await configuredValidTo(identity, host);
    console.log(
      `Configured identity (from ${configured.from}): "${identity.label}"\n  SHA-1:   ${identity.sha1}\n  Expires: ${validTo.toISOString()}`,
    );
    return;
  }
  const local = readLocalIdentity(host);
  if (local.kind === "absent") {
    console.log(
      "No local identity yet: the next gateway build (`./equin start`) creates one.",
    );
    return;
  }
  if (local.kind === "partial") {
    console.error(
      `The local identity is incomplete: ${local.missing} is missing. ${RESET_HINT}.`,
    );
    process.exit(1);
  }
  console.log(
    `Local identity: "${local.identity.label}"\n  SHA-1:   ${local.identity.sha1}\n  Expires: ${local.identity.validTo.toISOString()}\n  Files:   ${local.identity.certPath}, ${local.identity.keyPath}`,
  );
};

export default run;
