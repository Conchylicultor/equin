import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import {
  machineHost,
  runOk,
  type CodesignHost,
  type RcodesignTool,
} from "./host";
import {
  readConfiguredValue,
  readLocalIdentity,
  resolveConfigured,
  resolveSigningIdentity,
  type SigningIdentity,
} from "./identity";

/** What {@link signBinary} did. */
export type SignOutcome =
  /** Not macOS: nothing is signed there. */
  | { readonly kind: "unsupported"; readonly platform: NodeJS.Platform }
  /** Already signed by this identity with this identifier: left untouched. */
  | { readonly kind: "already-signed"; readonly identity: SigningIdentity }
  | { readonly kind: "signed"; readonly identity: SigningIdentity };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/**
 * The requirement a binary signed by `identity` as `identifier` satisfies —
 * and the one macOS stores with a permission grant (the default designated
 * requirement pins the same certificate: `certificate leaf` for a configured
 * one, `certificate root` for the self-signed local one, where root is leaf).
 */
export function signedByRequirement(identifier: string, sha1: string): string {
  return `identifier "${identifier}" and certificate leaf = H"${sha1.toLowerCase()}"`;
}

/**
 * Whether `path` carries a valid signature by the certificate `sha1` under
 * `identifier` (`codesign -v -R=…`). An ad-hoc, foreign, or broken signature
 * is `false`; a `codesign` that cannot answer throws.
 */
export async function isSignedBy(
  path: string,
  identifier: string,
  sha1: string,
  host: CodesignHost = machineHost(),
): Promise<boolean> {
  const argv = [
    "/usr/bin/codesign",
    "-v",
    `-R=${signedByRequirement(identifier, sha1)}`,
    path,
  ];
  const result = await host.run(argv);
  // 0: satisfied. 1: no valid signature. 3: valid, but not this requirement.
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1 || result.exitCode === 3) return false;
  throw new Error(
    `\`${argv.join(" ")}\` failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
  );
}

/**
 * Sign the Mach-O binary at `path` with this machine's identity, as
 * `identifier`, so its designated requirement — what macOS keys permission
 * grants to — stays the same across rebuilds. Idempotent: a binary already
 * signed by that identity and identifier is left alone (`already-signed`).
 * Does nothing off macOS.
 *
 * Signs a copy beside it and renames the copy into place, so a process running
 * the old file keeps its own pages (`rcodesign` rewrites a file in place, which
 * a running process must never see). No hardened runtime, no entitlements; the
 * local identity is signed without a timestamp (no network).
 *
 * Throws when the configured identity cannot be resolved, a tool fails, or the
 * result does not verify — never leaves a binary signed by someone else.
 */
export async function signBinary(
  path: string,
  opts: {
    identifier: string;
    exec: ExecContext;
    log?: (line: string) => void;
    host?: CodesignHost;
  },
): Promise<SignOutcome> {
  const host = opts.host ?? machineHost();
  const log = opts.log ?? (() => {});
  if (!IDENTIFIER.test(opts.identifier)) {
    throw new Error(
      `signBinary: identifier ${JSON.stringify(opts.identifier)} must match ${IDENTIFIER}`,
    );
  }
  const identity = await resolveSigningIdentity(host);
  if (identity === null)
    return { kind: "unsupported", platform: host.platform };

  if (await isSignedBy(path, opts.identifier, identity.sha1, host)) {
    return { kind: "already-signed", identity };
  }

  const tmp = `${path}.signing-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    copyFileSync(path, tmp);
    chmodSync(tmp, statSync(path).mode & 0o7777);
    if (identity.kind === "configured") {
      await runOk(host, [
        "/usr/bin/codesign",
        "--force",
        "--sign",
        identity.sha1,
        "--identifier",
        opts.identifier,
        tmp,
      ]);
    } else {
      await runOk(host, [
        await host.rcodesignPath({ exec: opts.exec }),
        "sign",
        "--pem-file",
        identity.keyPath,
        "--pem-file",
        identity.certPath,
        "--binary-identifier",
        opts.identifier,
        "--timestamp-url",
        "none",
        tmp,
      ]);
    }
    if (!(await isSignedBy(tmp, opts.identifier, identity.sha1, host))) {
      throw new Error(
        `signed ${path} with ${identity.kind} identity ${identity.sha1} "${identity.label}", but it does not satisfy ${signedByRequirement(opts.identifier, identity.sha1)}`,
      );
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  log(
    `signed ${path} as ${opts.identifier} with the ${identity.kind} identity "${identity.label}" (${identity.sha1})`,
  );
  return { kind: "signed", identity };
}

/**
 * Sign the macOS app bundle at `bundle` IN PLACE with this machine's identity,
 * as `identifier` — which must be the bundle's own `CFBundleIdentifier` (a
 * bundle's signing identifier is its bundle id; a mismatch throws). Every
 * executable in `Contents/MacOS` is signed with it: the main one by the bundle
 * signature, every other one as nested code, which the bundle's seal then
 * covers. Does nothing off macOS.
 *
 * In place, unlike {@link signBinary}: the caller assembles the bundle in a
 * staging directory nothing runs from, and swaps the signed whole in — a
 * running process must never see its files rewritten.
 *
 * Throws when the configured identity cannot be resolved, a tool fails, or the
 * result does not verify.
 */
export async function signBundle(
  bundle: string,
  opts: {
    identifier: string;
    tool: RcodesignTool;
    log?: (line: string) => void;
    host?: CodesignHost;
  },
): Promise<Exclude<SignOutcome, { kind: "already-signed" }>> {
  const host = opts.host ?? machineHost();
  const log = opts.log ?? (() => {});
  const plist = readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");
  const declared = plistString(plist, "CFBundleIdentifier");
  if (declared !== opts.identifier) {
    throw new Error(
      `signBundle: ${bundle} declares CFBundleIdentifier ${JSON.stringify(declared)}, not ${JSON.stringify(opts.identifier)} — a bundle is signed as its own bundle id`,
    );
  }
  const main = plistString(plist, "CFBundleExecutable");
  if (main === null) {
    throw new Error(
      `signBundle: ${bundle}'s Info.plist names no CFBundleExecutable`,
    );
  }
  const identity = await resolveSigningIdentity(host);
  if (identity === null)
    return { kind: "unsupported", platform: host.platform };

  if (identity.kind === "configured") {
    // `codesign` refuses a bundle whose nested code is unsigned, and signs no
    // nested code itself (short of the deprecated `--deep`): each other
    // executable first, under its own name, then the bundle.
    const macos = join(bundle, "Contents", "MacOS");
    for (const name of readdirSync(macos).sort()) {
      if (name === main) continue;
      await runOk(host, [
        "/usr/bin/codesign",
        "--force",
        "--sign",
        identity.sha1,
        "--identifier",
        name,
        join(macos, name),
      ]);
    }
    await runOk(host, [
      "/usr/bin/codesign",
      "--force",
      "--sign",
      identity.sha1,
      bundle,
    ]);
  } else {
    // rcodesign signs the nested executables itself, then the bundle.
    await runOk(host, [
      await host.rcodesignPath(opts.tool),
      "sign",
      "--pem-file",
      identity.keyPath,
      "--pem-file",
      identity.certPath,
      "--timestamp-url",
      "none",
      bundle,
    ]);
  }
  if (!(await isSignedBy(bundle, opts.identifier, identity.sha1, host))) {
    throw new Error(
      `signed ${bundle} with ${identity.kind} identity ${identity.sha1} "${identity.label}", but it does not satisfy ${signedByRequirement(opts.identifier, identity.sha1)}`,
    );
  }
  log(
    `signed ${bundle} as ${opts.identifier} with the ${identity.kind} identity "${identity.label}" (${identity.sha1})`,
  );
  return { kind: "signed", identity };
}

/**
 * Whether the code at `path` (a Mach-O, or an app bundle) carries the
 * signature this machine's identity would give it as `identifier` — asked
 * WITHOUT side effects (the local identity is read, never minted; nothing is
 * signed), for a reader that only reports.
 *
 * - `unsupported` — not macOS: nothing is signed there;
 * - `no-identity` — this machine has no local identity yet (the next sign
 *   creates one);
 * - `signed` / `unsigned` — by that identity, as `identifier`.
 */
export async function codeSignature(
  path: string,
  identifier: string,
  host: CodesignHost = machineHost(),
): Promise<"unsupported" | "no-identity" | "signed" | "unsigned"> {
  if (host.platform !== "darwin") return "unsupported";
  const configured = readConfiguredValue(host);
  let sha1: string;
  if (configured !== null) {
    sha1 = (await resolveConfigured(configured, host)).sha1;
  } else {
    const local = readLocalIdentity(host);
    if (local.kind !== "present") return "no-identity";
    sha1 = local.identity.sha1;
  }
  return (await isSignedBy(path, identifier, sha1, host))
    ? "signed"
    : "unsigned";
}

/** A `<string>` value of an XML `Info.plist`, or null. */
function plistString(plist: string, key: string): string | null {
  return (
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(
      plist,
    )?.[1] ?? null
  );
}
