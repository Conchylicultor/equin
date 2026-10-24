import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, renameSync, rmSync, statSync } from "node:fs";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { machineHost, runOk, type CodesignHost } from "./host";
import { resolveSigningIdentity, type SigningIdentity } from "./identity";

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
        await host.rcodesignPath(opts.exec),
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
