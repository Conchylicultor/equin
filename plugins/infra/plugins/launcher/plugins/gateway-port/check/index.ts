import type { Check } from "@plugins/framework/plugins/tooling/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { isTestFilePath } from "@plugins/framework/plugins/tooling/plugins/test-layout/core";
import {
  GATEWAY_PORT_RANGE,
  LEGACY_GATEWAY_PORT,
} from "@plugins/infra/plugins/namespace/core";

const RULE = "gateway-port:no-port-literal";

/** The ports this rule watches: the legacy one and the whole range. */
const PORTS = [
  LEGACY_GATEWAY_PORT,
  ...Array.from(
    { length: GATEWAY_PORT_RANGE.last - GATEWAY_PORT_RANGE.first + 1 },
    (_, i) => GATEWAY_PORT_RANGE.first + i,
  ),
];
const PORT_ALT = PORTS.join("|");

/** A loopback or namespace host followed by one of {@link PORTS} (`localhost`, `127.0.0.1` or `[::1]`, then `:` and the port). */
const HOST_PORT = new RegExp(
  String.raw`(?:localhost|127\.0\.0\.1|\[::1\]):(?:${PORT_ALT})(?!\d)`,
);
/** A bare port number, in the languages that cannot import the owner (Go, Rust, shell). */
const BARE_PORT = new RegExp(String.raw`(?<![\w.])(?:${PORT_ALT})(?![\w])`);

/** Where the bare-number rule applies: what spells the port with no TypeScript import to reach for. */
function isForeignLanguage(rel: string): boolean {
  return /\.(go|rs|sh)$/.test(rel);
}

/**
 * Not where a port is derived. Sample data: tests and their fixtures (TS
 * through the `test` category and `isTestFilePath`, Go's `_test.go` and
 * `testdata/`) — the stance `namespace:no-hand-built-url` takes. Data and
 * history: JSON (third-party catalogs; `.mcp.json`'s fallback, which
 * `mcp:mcp-json-in-sync` pins to the default port by derivation), lockfiles,
 * SQL (a published migration is immutable). Sidequests: independent projects
 * with their own lifecycle (one drives the pre-move tree, which listens on
 * 9000 and has no `./equin url`). Research notes and generated files are the
 * check's `outOfScope` categories.
 */
function notADerivation(rel: string): boolean {
  return (
    isTestFilePath(rel) ||
    rel.endsWith("_test.go") ||
    rel.includes("/testdata/") ||
    /\.(json|lock|sql)$/.test(rel) ||
    rel.split("/")[0] === "sidequests"
  );
}

/**
 * The lines of a file that are not test code: a Rust file's inline test module
 * (`#[cfg(test)]`, by convention the file's end) is cut off.
 */
function liveLines(rel: string, src: string): string[] {
  const lines = src.split("\n");
  if (!rel.endsWith(".rs")) return lines;
  const cut = lines.findIndex((l) => l.trim() === "#[cfg(test)]");
  return cut === -1 ? lines : lines.slice(0, cut);
}

/**
 * The gateway's port is a per-account value (`launcher/gateway-port`): every
 * reader gets it from its runtime's authority — the port file, the env its
 * gateway hands it, the page's own location — and every URL builder takes it
 * as an argument. A spelled-out port in a URL is how the port came to live
 * in two dozen places, each of which silently kept pointing at the old one
 * when it moved. This check keeps any new one from creeping back: in code,
 * comments and docs alike (people and agents copy the address they read), and
 * as a bare number in Go, Rust and shell, which cannot import the owner.
 *
 * The owner spells its values once (`namespace/core/namespace.ts`, as named
 * constants), and so does the menu-bar helper's legacy fallback — the one
 * declared exemption.
 */
const noPortLiteralCheck: Check = {
  // INPUT-KEYED: a pure function of the `git grep -l` selection, its
  // candidates' content and the exemption manifests.
  inputKeyed: true,
  id: RULE,
  outOfScope: ["research", "generated"],
  description:
    "no file spells the gateway's port (the legacy one or any of the range) after a loopback host — it is a per-account value read from launcher/gateway-port; write `<port>` in prose",
  exemptable: {
    [RULE]:
      "spells a gateway port on purpose — the one constant a language with no TypeScript import keeps for the port of an install that has not moved",
  },
  async run(ctx) {
    const exempt = await ctx.exempt(RULE);
    const offenders: string[] = [];
    const candidates = await listCandidateSources({
      grepArg: `(${PORT_ALT})`,
      pathspecs: ["."],
    });
    for (const { rel, src } of candidates) {
      if (notADerivation(rel) || exempt.skips(rel)) continue;
      const bare = isForeignLanguage(rel);
      liveLines(rel, src).forEach((text, i) => {
        if (HOST_PORT.test(text) || (bare && BARE_PORT.test(text))) {
          offenders.push(`${rel}:${i + 1}\n        ${text.trim()}`);
        }
      });
    }
    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${offenders.length} spelled-out gateway port(s):\n    ${offenders.join("\n    ")}`,
      hint:
        "The port is this account's (8700 by default, the first free one of the range; `./equin url` prints it). " +
        "Code reads it — `gatewayPortSync()` / `gatewayOriginSync()` (data-dirs: CLI, scripts), `resolveGatewayPort()` (machine, async), `servedGatewayPort()` (core: a process a gateway started), `pagePort(location)` (a page) — from `@plugins/infra/plugins/launcher/plugins/gateway-port`, and passes it to `namespaceUrl(ns, path, port)`. " +
        "Prose writes `http://<worktree>.localhost:<port>`. Shell asks `./equin url`. " +
        `A file that must keep one declares a \`${RULE}\` exemption in its plugin's \`exempt/index.ts\`, with the reason.`,
    };
  },
};

export default noPortLiteralCheck;
