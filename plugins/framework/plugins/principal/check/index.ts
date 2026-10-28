import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
// Own plugin, so relative.
import { PRINCIPAL_HEADER } from "../core/principal";
import { PRINCIPAL_STAMPED_FLAG } from "../core/stamp";

const GATEWAY_FILE = "gateway/principal.go";

/** `const principalHeader = "<name>"` — the Go constant's declaration. */
const GO_CONSTANT = /\bprincipalHeader\s*=\s*"([^"]+)"/;
/** `const principalStampedFlag = "<flag>"` — the handshake flag's declaration. */
const GO_FLAG_CONSTANT = /\bprincipalStampedFlag\s*=\s*"([^"]+)"/;

/**
 * The principal header is written by the gateway (Go) and read by the socket
 * hosts (TypeScript), and Go cannot import the TypeScript constant. A drift is
 * silent and total: every backend would read a header nobody stamps, so every
 * request — the owner's included — would be anonymous (fail closed), and the
 * app would refuse its own page. Header names are case-insensitive, so the two
 * spellings are compared that way.
 */
const headerInSyncCheck: Check = {
  id: "principal:header-in-sync",
  description:
    "The gateway's principal header (principalHeader in gateway/principal.go) must name the header the socket hosts read (PRINCIPAL_HEADER), and its stamp-handshake argv flag (principalStampedFlag) the flag they look for (PRINCIPAL_STAMPED_FLAG)",
  async run() {
    const root = await getWorktreeRoot();
    const text = await readFile(join(root, GATEWAY_FILE), "utf8");
    const match = GO_CONSTANT.exec(text);
    if (!match) {
      return {
        ok: false,
        message: `${GATEWAY_FILE} declares no \`principalHeader = "…"\` constant`,
        hint: "The gateway stamps the principal under that constant; the check reads it to pin it to PRINCIPAL_HEADER in plugins/framework/plugins/principal/core.",
      };
    }
    const goName = match[1]!;
    if (goName.toLowerCase() !== PRINCIPAL_HEADER.toLowerCase()) {
      return {
        ok: false,
        message: `the gateway stamps "${goName}" but the socket hosts read "${PRINCIPAL_HEADER}"`,
        hint: "Make gateway/principal.go's principalHeader and PRINCIPAL_HEADER (plugins/framework/plugins/principal/core/principal.ts) name the same header — otherwise every request, the owner's included, reads as anonymous and is refused.",
      };
    }
    // The handshake: the argv flag the gateway declares the stamp with. A
    // drift turns the gate off on every host (each reads "not stamped").
    const flag = GO_FLAG_CONSTANT.exec(text)?.[1];
    if (flag !== PRINCIPAL_STAMPED_FLAG) {
      return {
        ok: false,
        message:
          flag === undefined
            ? `${GATEWAY_FILE} declares no \`principalStampedFlag = "…"\` constant`
            : `the gateway declares the stamp with "${flag}" but the socket hosts look for "${PRINCIPAL_STAMPED_FLAG}"`,
        hint: "Make gateway/principal.go's principalStampedFlag and PRINCIPAL_STAMPED_FLAG (plugins/framework/plugins/principal/core/stamp.ts) the same flag — otherwise every host serves ungated, as if behind a gateway older than the stamp.",
      };
    }
    return { ok: true };
  },
};

export default [headerInSyncCheck];
