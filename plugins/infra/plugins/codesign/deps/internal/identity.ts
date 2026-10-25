import { X509Certificate, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { machineHost, runOk, type CodesignHost } from "./host";

/** The common name of the local certificate this plugin creates. */
export const LOCAL_IDENTITY_NAME = "equin Local Code Signing";
/** 20 years: the local certificate should outlive the machine. */
const LOCAL_CERT_DAYS = 7300;

/**
 * Who signs. Its SHA-1 (the certificate's, uppercase hex) is what the
 * designated requirement pins, so it is what keeps permission grants across
 * rebuilds.
 *
 * - `configured`: a VALID identity in the user's keychains, named by
 *   `EQUIN_CODESIGN_IDENTITY` or the `identity` file — an Apple
 *   "Developer ID Application" / "Apple Development" identity. Signed with
 *   `/usr/bin/codesign`.
 * - `local`: the machine's own self-signed certificate under
 *   `state/codesign/local/`, created on first use. Signed with `rcodesign`
 *   from the PEM files, so it needs no keychain and no trust settings.
 */
export type SigningIdentity =
  | {
      readonly kind: "configured";
      readonly sha1: string;
      readonly label: string;
    }
  | {
      readonly kind: "local";
      readonly sha1: string;
      readonly label: string;
      readonly keyPath: string;
      readonly certPath: string;
      readonly validTo: Date;
    };

/** Where the configured identity comes from, for messages. */
export interface ConfiguredValue {
  readonly value: string;
  readonly from: string;
}

/** The files of the local identity. */
export function localIdentityPaths(host: CodesignHost): {
  dir: string;
  keyPath: string;
  certPath: string;
} {
  const dir = join(host.dir, "local");
  return {
    dir,
    keyPath: join(dir, "key.pem"),
    certPath: join(dir, "cert.pem"),
  };
}

/** The configured identity file. */
export function configuredIdentityFile(host: CodesignHost): string {
  return join(host.dir, "identity");
}

/**
 * The configured identity, if any: the environment variable, else the
 * `identity` file. An empty file is a mistake, not "none" — it throws.
 */
export function readConfiguredValue(
  host: CodesignHost,
): ConfiguredValue | null {
  const fromEnv = readEnv("CODESIGN_IDENTITY", host.env)?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return { value: fromEnv, from: envName("CODESIGN_IDENTITY") };
  }
  const file = configuredIdentityFile(host);
  if (!existsSync(file)) return null;
  const value = readFileSync(file, "utf8").trim();
  if (value === "") {
    throw new Error(
      `${file} is empty. Write a certificate SHA-1 or the exact name of a code-signing identity into it, or delete it to sign with this machine's local identity.`,
    );
  }
  return { value, from: file };
}

interface FoundIdentity {
  readonly sha1: string;
  readonly label: string;
  /** What `security` says is wrong with it (`CSSMERR_TP_CERT_EXPIRED`), if anything. */
  readonly problem: string | null;
}

const IDENTITY_LINE = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.*)"(?:\s+\((.+)\))?\s*$/;

/** The identity lines of `security find-identity` output, one per SHA-1. */
export function parseFindIdentity(stdout: string): FoundIdentity[] {
  const bySha = new Map<string, FoundIdentity>();
  for (const line of stdout.split("\n")) {
    const m = IDENTITY_LINE.exec(line);
    if (m === null) continue;
    const sha1 = m[1]!;
    if (!bySha.has(sha1)) {
      bySha.set(sha1, { sha1, label: m[2]!, problem: m[3] ?? null });
    }
  }
  return [...bySha.values()];
}

function matches(found: FoundIdentity, value: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(value)
    ? found.sha1 === value.toUpperCase()
    : found.label === value;
}

/**
 * Resolve a configured value to exactly one VALID code-signing identity in the
 * user's keychains. None, several, or one that `security` says is not valid
 * (expired, untrusted) throws: signing with anything else would silently change
 * the signer, and with it every permission grant.
 */
export async function resolveConfigured(
  configured: ConfiguredValue,
  host: CodesignHost,
): Promise<SigningIdentity & { kind: "configured" }> {
  const valid = parseFindIdentity(
    (
      await runOk(host, [
        "security",
        "find-identity",
        "-v",
        "-p",
        "codesigning",
      ])
    ).stdout,
  ).filter((f) => matches(f, configured.value));
  if (valid.length === 1) {
    return { kind: "configured", sha1: valid[0]!.sha1, label: valid[0]!.label };
  }
  const where = `the code-signing identity ${JSON.stringify(configured.value)} (from ${configured.from})`;
  if (valid.length > 1) {
    throw new Error(
      `${where} matches ${valid.length} identities: ${valid.map((f) => `${f.sha1} "${f.label}"`).join(", ")}. Name one by its SHA-1.`,
    );
  }
  const any = parseFindIdentity(
    (await runOk(host, ["security", "find-identity", "-p", "codesigning"]))
      .stdout,
  ).filter((f) => matches(f, configured.value));
  if (any.length > 0) {
    throw new Error(
      `${where} is in your keychain but not valid for code signing (${any.map((f) => f.problem ?? "not valid").join(", ")}). Renew it, or point the setting at another identity.`,
    );
  }
  throw new Error(
    `${where} is not in your keychains. \`security find-identity -v -p codesigning\` lists the ones you have; or unset it to sign with this machine's local identity.`,
  );
}

/** What the local identity's files say about it. */
export type LocalIdentityState =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly identity: SigningIdentity & { kind: "local" };
    }
  | { readonly kind: "partial"; readonly missing: string };

/** Read the local identity from disk, never creating it. */
export function readLocalIdentity(host: CodesignHost): LocalIdentityState {
  const { dir, keyPath, certPath } = localIdentityPaths(host);
  if (!existsSync(dir)) return { kind: "absent" };
  for (const path of [keyPath, certPath]) {
    if (!existsSync(path)) return { kind: "partial", missing: path };
  }
  const cert = new X509Certificate(readFileSync(certPath));
  return {
    kind: "present",
    identity: {
      kind: "local",
      sha1: cert.fingerprint.replaceAll(":", "").toUpperCase(),
      label: commonName(cert) ?? LOCAL_IDENTITY_NAME,
      keyPath,
      certPath,
      validTo: new Date(cert.validTo),
    },
  };
}

function commonName(cert: X509Certificate): string | null {
  const cn = cert.subject.split("\n").find((l) => l.startsWith("CN="));
  return cn === undefined ? null : cn.slice(3);
}

const CERT_CONFIG = `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = ${LOCAL_IDENTITY_NAME}
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
`;

/** How to reset a broken local identity, for messages. */
export const RESET_HINT =
  "`./equin codesign reset` removes it, and the next gateway build creates a new one (macOS then asks again for every permission the gateway had)";

/**
 * The local identity, created on first use. Created under the machine-wide
 * lock into a temp directory renamed into place, so a crash leaves nothing or
 * everything. A half-present one (a file deleted by hand) throws: re-creating
 * it silently would change the signer.
 */
export async function ensureLocalIdentity(
  host: CodesignHost,
): Promise<SigningIdentity & { kind: "local" }> {
  const first = readLocalIdentity(host);
  if (first.kind === "present") return first.identity;
  if (first.kind === "partial") throw partialError(first.missing);

  mkdirSync(host.dir, { recursive: true, mode: 0o700 });
  chmodSync(host.dir, 0o700);
  return host.withLock(join(host.dir, ".lock"), async () => {
    const again = readLocalIdentity(host);
    if (again.kind === "present") return again.identity;
    if (again.kind === "partial") throw partialError(again.missing);

    const { dir } = localIdentityPaths(host);
    const tmp = `${dir}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    mkdirSync(tmp, { mode: 0o700 });
    try {
      writeFileSync(join(tmp, "cert.cnf"), CERT_CONFIG);
      // /usr/bin/openssl: the system's (LibreSSL), never a Homebrew one on PATH.
      await runOk(host, [
        "/usr/bin/openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        String(LOCAL_CERT_DAYS),
        "-config",
        join(tmp, "cert.cnf"),
        "-keyout",
        join(tmp, "key.pem"),
        "-out",
        join(tmp, "cert.pem"),
      ]);
      rmSync(join(tmp, "cert.cnf"));
      chmodSync(join(tmp, "key.pem"), 0o600);
      renameSync(tmp, dir);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    const created = readLocalIdentity(host);
    if (created.kind !== "present") {
      throw new Error(
        `created the local code-signing identity in ${dir}, but reading it back gave ${created.kind}`,
      );
    }
    return created.identity;
  });
}

function partialError(missing: string): Error {
  return new Error(
    `the local code-signing identity is incomplete: ${missing} is missing. ${RESET_HINT}.`,
  );
}

/**
 * The identity this machine signs with: the configured one when set (which
 * must resolve, or this throws), else the local one (created on first use).
 * `null` only off macOS, where nothing is signed.
 */
export async function resolveSigningIdentity(
  host: CodesignHost = machineHost(),
): Promise<SigningIdentity | null> {
  if (host.platform !== "darwin") return null;
  const configured = readConfiguredValue(host);
  if (configured !== null) return resolveConfigured(configured, host);
  return ensureLocalIdentity(host);
}

/**
 * The expiry of a configured identity's certificate, read from the keychain
 * (`security find-certificate -c <name> -Z -p`, matched by SHA-1).
 */
export async function configuredValidTo(
  identity: SigningIdentity & { kind: "configured" },
  host: CodesignHost,
): Promise<Date> {
  const { stdout } = await runOk(host, [
    "security",
    "find-certificate",
    "-a",
    "-c",
    identity.label,
    "-Z",
    "-p",
  ]);
  let sha: string | null = null;
  let pem: string[] | null = null;
  for (const line of stdout.split("\n")) {
    const hash = /^SHA-1 hash:\s*([0-9A-F]{40})/.exec(line);
    if (hash !== null) sha = hash[1]!;
    if (line.startsWith("-----BEGIN CERTIFICATE-----")) pem = [];
    if (pem !== null) pem.push(line);
    if (line.startsWith("-----END CERTIFICATE-----") && pem !== null) {
      if (sha === identity.sha1) {
        return new Date(new X509Certificate(pem.join("\n")).validTo);
      }
      pem = null;
    }
  }
  throw new Error(
    `no certificate with SHA-1 ${identity.sha1} named "${identity.label}" in your keychains`,
  );
}
