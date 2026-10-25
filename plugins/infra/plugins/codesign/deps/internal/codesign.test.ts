import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execContextForTests } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing";
import type { CodesignHost, CommandResult } from "./host";
import {
  CODESIGN_IDENTITY_ENV,
  configuredValidTo,
  ensureLocalIdentity,
  parseFindIdentity,
  readConfiguredValue,
  readLocalIdentity,
  resolveSigningIdentity,
} from "./identity";
import { isSignedBy, signBinary, signedByRequirement } from "./sign";

const exec = execContextForTests();

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}
const DEV_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DEV_ID_2 = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const EXPIRED = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const FIND_VALID = `  1) ${DEV_ID} "Developer ID Application: Jane (TEAM1)"
  2) ${DEV_ID_2} "Apple Development: Jane (TEAM2)"
  3) ${DEV_ID_2} "Apple Development: Jane (TEAM2)"
     2 valid identities found
`;
const FIND_ALL = `
Policy: Code Signing
  Matching identities
  1) ${DEV_ID} "Developer ID Application: Jane (TEAM1)"
  2) ${DEV_ID_2} "Apple Development: Jane (TEAM2)"
  3) ${EXPIRED} "Old Cert" (CSSMERR_TP_CERT_EXPIRED)
     3 identities found

  Valid identities only
  1) ${DEV_ID} "Developer ID Application: Jane (TEAM1)"
  2) ${DEV_ID_2} "Apple Development: Jane (TEAM2)"
     2 valid identities found
`;

let base: string;
let calls: string[][];

/**
 * A machine whose `security` answers from the canned listings above and whose
 * `codesign` / `rcodesign` "sign" a file by writing `signed:<id>:<SHA1>` into
 * it — which is what the fake `codesign -v -R=…` reads back. `openssl` is real.
 */
function fakeHost(over: Partial<CodesignHost> = {}): CodesignHost {
  const ok = (stdout = ""): CommandResult => ({
    exitCode: 0,
    stdout,
    stderr: "",
  });
  const host: CodesignHost = {
    platform: "darwin",
    env: {},
    dir: join(base, "codesign"),
    async run(argv) {
      calls.push([...argv]);
      const [cmd, ...args] = argv;
      if (cmd === "security" && args[0] === "find-identity") {
        return ok(args.includes("-v") ? FIND_VALID : FIND_ALL);
      }
      if (cmd === "/usr/bin/codesign" && args[0] === "-v") {
        const m =
          /^-R=identifier "(.+)" and certificate leaf = H"([0-9a-f]+)"$/.exec(
            args[1]!,
          );
        const path = args[2]!;
        if (m === null) throw new Error(`unexpected requirement ${args[1]}`);
        if (!existsSync(path))
          return { exitCode: 1, stdout: "", stderr: "no such file" };
        const signed =
          readFileSync(path, "utf8") ===
          `signed:${m[1]}:${m[2]!.toUpperCase()}`;
        return signed
          ? ok()
          : { exitCode: 3, stdout: "", stderr: "requirement not satisfied" };
      }
      if (cmd === "/usr/bin/codesign" && args[0] === "--force") {
        // --force --sign <sha1> --identifier <id> <path>
        writeFileSync(args[5]!, `signed:${args[4]}:${args[2]}`);
        return ok();
      }
      if (cmd === "/fake/rcodesign") {
        const cert = args[args.indexOf("--pem-file", 2) + 1]!;
        const id = args[args.indexOf("--binary-identifier") + 1]!;
        const local = readLocalIdentity(host);
        if (local.kind !== "present" || local.identity.certPath !== cert) {
          throw new Error("rcodesign got the wrong cert");
        }
        writeFileSync(argv.at(-1)!, `signed:${id}:${local.identity.sha1}`);
        return ok();
      }
      if (cmd === "/usr/bin/openssl") {
        const r = spawnSync(cmd, args, { encoding: "utf8" });
        return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      }
      throw new Error(`unexpected command ${argv.join(" ")}`);
    },
    withLock: async (_path, fn) => fn(),
    rcodesignPath: async () => "/fake/rcodesign",
    ...over,
  };
  return host;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "codesign-test-"));
  calls = [];
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("parseFindIdentity", () => {
  test("one entry per SHA-1, with the problem security reports", () => {
    expect(parseFindIdentity(FIND_ALL)).toEqual([
      {
        sha1: DEV_ID,
        label: "Developer ID Application: Jane (TEAM1)",
        problem: null,
      },
      {
        sha1: DEV_ID_2,
        label: "Apple Development: Jane (TEAM2)",
        problem: null,
      },
      { sha1: EXPIRED, label: "Old Cert", problem: "CSSMERR_TP_CERT_EXPIRED" },
    ]);
  });
});

describe("resolveSigningIdentity", () => {
  test("off macOS: null, and nothing is run", async () => {
    expect(
      await resolveSigningIdentity(fakeHost({ platform: "linux" })),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  test("configured by exact name or by SHA-1 (any case), env over file", async () => {
    const byName = fakeHost({
      env: {
        [CODESIGN_IDENTITY_ENV]: "Developer ID Application: Jane (TEAM1)",
      },
    });
    expect(await resolveSigningIdentity(byName)).toEqual({
      kind: "configured",
      sha1: DEV_ID,
      label: "Developer ID Application: Jane (TEAM1)",
    });

    const host = fakeHost();
    mkdirSync(host.dir, { recursive: true });
    writeFileSync(join(host.dir, "identity"), `${DEV_ID_2.toLowerCase()}\n`);
    expect((await resolveSigningIdentity(host))?.sha1).toBe(DEV_ID_2);

    const envWins = fakeHost({ env: { [CODESIGN_IDENTITY_ENV]: DEV_ID } });
    writeFileSync(join(envWins.dir, "identity"), DEV_ID_2);
    expect((await resolveSigningIdentity(envWins))?.sha1).toBe(DEV_ID);
  });

  test("a configured identity that is missing, invalid or ambiguous throws — never falls back", async () => {
    const missing = fakeHost({ env: { [CODESIGN_IDENTITY_ENV]: "Nobody" } });
    expect(
      (await rejection(resolveSigningIdentity(missing))).message,
    ).toContain("not in your keychains");

    const expired = fakeHost({ env: { [CODESIGN_IDENTITY_ENV]: "Old Cert" } });
    expect(
      (await rejection(resolveSigningIdentity(expired))).message,
    ).toContain("CSSMERR_TP_CERT_EXPIRED");

    // Two distinct identities with one name.
    const ambiguous = fakeHost({
      env: { [CODESIGN_IDENTITY_ENV]: "Dup" },
      run: async () => ({
        exitCode: 0,
        stdout: `  1) ${DEV_ID} "Dup"\n  2) ${DEV_ID_2} "Dup"\n`,
        stderr: "",
      }),
    });
    expect(
      (await rejection(resolveSigningIdentity(ambiguous))).message,
    ).toContain("matches 2 identities");

    const host = fakeHost();
    mkdirSync(host.dir, { recursive: true });
    writeFileSync(join(host.dir, "identity"), "  \n");
    expect(() => readConfiguredValue(host)).toThrow("is empty");
    // No local identity was created along the way.
    expect(existsSync(join(host.dir, "local"))).toBe(false);
  });

  test("local: created once (0700 dir, 0600 key, 20 years, codeSigning), then read back unchanged", async () => {
    const host = fakeHost();
    expect(readLocalIdentity(host).kind).toBe("absent");
    const first = await ensureLocalIdentity(host);
    expect(first.kind).toBe("local");
    expect(first.label).toBe("equin Local Code Signing");
    expect(first.sha1).toMatch(/^[0-9A-F]{40}$/);
    expect(statSync(host.dir).mode & 0o777).toBe(0o700);
    expect(statSync(first.keyPath).mode & 0o777).toBe(0o600);
    expect(first.validTo.getTime() - Date.now()).toBeGreaterThan(
      19 * 365 * 86_400_000,
    );
    expect(readdirSync(join(host.dir, "local")).sort()).toEqual([
      "cert.pem",
      "key.pem",
    ]);
    const ext = spawnSync(
      "/usr/bin/openssl",
      ["x509", "-in", first.certPath, "-noout", "-text"],
      {
        encoding: "utf8",
      },
    );
    expect(ext.stdout).toContain("Code Signing");

    const again = await resolveSigningIdentity(host);
    expect(again).toEqual(first);
    expect(calls.filter((c) => c[0] === "/usr/bin/openssl")).toHaveLength(1);
  });

  test("a half-present local identity throws and points at reset", async () => {
    const host = fakeHost();
    const created = await ensureLocalIdentity(host);
    rmSync(created.keyPath);
    expect((await rejection(resolveSigningIdentity(host))).message).toContain(
      "codesign reset",
    );
  });
});

describe("signBinary", () => {
  test("off macOS: unsupported, the file untouched", async () => {
    const bin = join(base, "gateway");
    writeFileSync(bin, "binary");
    const outcome = await signBinary(bin, {
      identifier: "dev.example.tool",
      exec,
      host: fakeHost({ platform: "linux" }),
    });
    expect(outcome).toEqual({ kind: "unsupported", platform: "linux" });
    expect(readFileSync(bin, "utf8")).toBe("binary");
  });

  test("configured: /usr/bin/codesign, verified, mode kept; a second call is a no-op", async () => {
    const host = fakeHost({ env: { [CODESIGN_IDENTITY_ENV]: DEV_ID } });
    const bin = join(base, "gateway");
    writeFileSync(bin, "binary", { mode: 0o755 });
    const outcome = await signBinary(bin, {
      identifier: "dev.example.tool",
      exec,
      host,
    });
    expect(outcome.kind).toBe("signed");
    expect(readFileSync(bin, "utf8")).toBe(`signed:dev.example.tool:${DEV_ID}`);
    expect(statSync(bin).mode & 0o777).toBe(0o755);
    expect(
      calls.some((c) => c[0] === "/usr/bin/codesign" && c[1] === "--force"),
    ).toBe(true);
    // No temp copy left beside it.
    expect(readdirSync(base).filter((n) => n.startsWith("gateway"))).toEqual([
      "gateway",
    ]);

    calls = [];
    const again = await signBinary(bin, {
      identifier: "dev.example.tool",
      exec,
      host,
    });
    expect(again.kind).toBe("already-signed");
    expect(calls.some((c) => c[1] === "--force")).toBe(false);
  });

  test("local: rcodesign with the PEM files; a changed identity re-signs", async () => {
    const host = fakeHost();
    const bin = join(base, "gateway");
    writeFileSync(bin, "binary");
    const outcome = await signBinary(bin, {
      identifier: "dev.example.tool",
      exec,
      host,
    });
    expect(outcome.kind).toBe("signed");
    if (outcome.kind !== "signed" || outcome.identity.kind !== "local")
      throw new Error("expected local");
    expect(readFileSync(bin, "utf8")).toBe(
      `signed:dev.example.tool:${outcome.identity.sha1}`,
    );
    const rc = calls.find((c) => c[0] === "/fake/rcodesign")!;
    expect(rc).toContain("--timestamp-url");
    expect(rc[rc.indexOf("--timestamp-url") + 1]).toBe("none");

    // Configuring an identity later: the next call re-signs with it.
    const configured = fakeHost({ env: { [CODESIGN_IDENTITY_ENV]: DEV_ID } });
    expect(
      (
        await signBinary(bin, {
          identifier: "dev.example.tool",
          exec,
          host: configured,
        })
      ).kind,
    ).toBe("signed");
    expect(await isSignedBy(bin, "dev.example.tool", DEV_ID, configured)).toBe(
      true,
    );
  });

  test("a signature that does not verify throws and leaves the original file", async () => {
    const host = fakeHost({ env: { [CODESIGN_IDENTITY_ENV]: DEV_ID } });
    const real = host.run.bind(host);
    const lying: CodesignHost = {
      ...host,
      run: async (argv) =>
        argv[1] === "--force"
          ? { exitCode: 0, stdout: "", stderr: "" }
          : real(argv),
    };
    const bin = join(base, "gateway");
    writeFileSync(bin, "binary");
    expect(
      (
        await rejection(
          signBinary(bin, {
            identifier: "dev.example.tool",
            exec,
            host: lying,
          }),
        )
      ).message,
    ).toContain("does not satisfy");
    expect(readFileSync(bin, "utf8")).toBe("binary");
  });

  test("a failing codesign throws; an unknown codesign -v exit throws", async () => {
    const host = fakeHost({ env: { [CODESIGN_IDENTITY_ENV]: DEV_ID } });
    const real = host.run.bind(host);
    const failing: CodesignHost = {
      ...host,
      run: async (argv) =>
        argv[1] === "--force"
          ? { exitCode: 1, stdout: "", stderr: "errSecInternalComponent" }
          : real(argv),
    };
    const bin = join(base, "gateway");
    writeFileSync(bin, "binary");
    expect(
      (
        await rejection(
          signBinary(bin, {
            identifier: "dev.example.tool",
            exec,
            host: failing,
          }),
        )
      ).message,
    ).toContain("errSecInternalComponent");
    const broken: CodesignHost = {
      ...host,
      run: async () => ({ exitCode: 2, stdout: "", stderr: "bad option" }),
    };
    expect(
      (await rejection(isSignedBy(bin, "x", DEV_ID, broken))).message,
    ).toContain("bad option");
  });

  test("rejects a malformed identifier", async () => {
    expect(
      (
        await rejection(
          signBinary(join(base, "x"), {
            identifier: 'a" or true',
            exec,
            host: fakeHost(),
          }),
        )
      ).message,
    ).toContain("must match");
  });
});

describe("configuredValidTo", () => {
  test("reads the expiry of the certificate with the identity's SHA-1", async () => {
    const host = fakeHost();
    const local = await ensureLocalIdentity(host);
    const pem = readFileSync(local.certPath, "utf8").trim();
    const listing = `SHA-1 hash: ${DEV_ID_2}\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\nSHA-1 hash: ${local.sha1}\n${pem}\n`;
    const keychain = fakeHost({
      run: async () => ({ exitCode: 0, stdout: listing, stderr: "" }),
    });
    const validTo = await configuredValidTo(
      { kind: "configured", sha1: local.sha1, label: local.label },
      keychain,
    );
    expect(validTo).toEqual(local.validTo);
    expect(
      (
        await rejection(
          configuredValidTo(
            { kind: "configured", sha1: DEV_ID, label: "x" },
            keychain,
          ),
        )
      ).message,
    ).toContain("no certificate");
  });
});

test("signedByRequirement pins the identifier and the leaf certificate", () => {
  expect(signedByRequirement("dev.example.tool", DEV_ID)).toBe(
    `identifier "dev.example.tool" and certificate leaf = H"${DEV_ID.toLowerCase()}"`,
  );
});
