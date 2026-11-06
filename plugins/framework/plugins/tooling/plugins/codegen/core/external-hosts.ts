// Third-party hosts declared in a web barrel, read statically as text: each
// `ExternalHosts.Declare({ hosts: ["…"], reason: "…" })` contribution
// (`framework/browser-server/web`). The browser-host codegen reads them into
// a host's `externalHosts`; a value it cannot read is refused, never dropped.

import {
  findMarkerCalls,
  maskSource,
} from "@plugins/plugin-meta/plugins/parse-utils/core";

/** One declaration: its hosts and why. */
export interface ExternalHostsDecl {
  hosts: string[];
  reason: string;
}

/** A host name as declared: lowercase labels, no scheme, port or path. */
const HOST_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const STRING_RE = /"([^"\\]*)"/g;

/**
 * Every `ExternalHosts.Declare({ … })` call in `source` (comments and
 * strings masked when locating it). `hosts` must be an array of string
 * literals and `reason` one string literal (or a concatenation of them);
 * anything else throws, naming the call.
 */
export function parseExternalHostsDeclarations(
  source: string,
): ExternalHostsDecl[] {
  const masked = maskSource(source);
  const out: ExternalHostsDecl[] = [];
  for (const call of findMarkerCalls(source, "Declare")) {
    if (!/\bExternalHosts\.$/.test(masked.slice(0, call.index))) continue;
    const args = call.argsText;
    const hostsList = /\bhosts\s*:\s*\[([^\]]*)\]/.exec(args);
    const reason = /\breason\s*:\s*((?:"[^"\\]*"\s*\+?\s*)+)/.exec(args);
    if (hostsList === null || reason === null) {
      throw new Error(
        `ExternalHosts.Declare(${args.trim()}) must spell \`hosts\` as an array of string literals and \`reason\` as a string literal — it is read statically.`,
      );
    }
    const hosts = [...hostsList[1]!.matchAll(STRING_RE)].map((m) => m[1]!);
    const rest = hostsList[1]!.replace(STRING_RE, "").replace(/[\s,]/g, "");
    if (hosts.length === 0 || rest !== "") {
      throw new Error(
        `ExternalHosts.Declare: \`hosts: [${hostsList[1]!.trim()}]\` must be a non-empty array of string literals.`,
      );
    }
    for (const host of hosts) {
      if (!HOST_RE.test(host)) {
        throw new Error(
          `ExternalHosts.Declare: "${host}" is not a host name (lowercase, no scheme, port or path).`,
        );
      }
    }
    out.push({
      hosts,
      reason: [...reason[1]!.matchAll(STRING_RE)].map((m) => m[1]!).join(""),
    });
  }
  return out;
}
