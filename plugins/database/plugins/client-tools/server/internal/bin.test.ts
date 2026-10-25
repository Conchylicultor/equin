import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { describe, expect, it } from "bun:test";
import {
  PgClientToolMissingError,
  resolvePgClientBin,
  type ResolveContext,
} from "./bin";

function ctx(over: Partial<ResolveContext>, present: string[] = []) {
  return {
    env: {},
    platform: "darwin",
    arch: "arm64",
    pluginRoot: "/repo/plugins/database/plugins/client-tools",
    exists: (p: string) => present.includes(p),
    ...over,
  } satisfies ResolveContext;
}

const PKG_BIN =
  "/repo/plugins/database/plugins/client-tools/node_modules/@equin/pg-client-darwin-arm64/native/bin";

describe("resolvePgClientBin", () => {
  it("resolves the platform package's binary", () => {
    expect(resolvePgClientBin("pg_dump", ctx({}, [`${PKG_BIN}/pg_dump`]))).toBe(
      `${PKG_BIN}/pg_dump`,
    );
  });

  it("maps linux/x64 to its own package", () => {
    const bin =
      "/repo/plugins/database/plugins/client-tools/node_modules/@equin/pg-client-linux-x64/native/bin/pg_restore";
    expect(
      resolvePgClientBin(
        "pg_restore",
        ctx({ platform: "linux", arch: "x64" }, [bin]),
      ),
    ).toBe(bin);
  });

  it("prefers the release override over the package", () => {
    expect(
      resolvePgClientBin(
        "pg_restore",
        ctx(
          { env: envEntries({ PG_CLIENT_BIN_DIR: "/bundle/pg-client/bin" }) },
          ["/bundle/pg-client/bin/pg_restore", `${PKG_BIN}/pg_restore`],
        ),
      ),
    ).toBe("/bundle/pg-client/bin/pg_restore");
  });

  it("throws when the override names a missing file, rather than falling back", () => {
    expect(() =>
      resolvePgClientBin(
        "pg_dump",
        ctx(
          { env: envEntries({ PG_CLIENT_BIN_DIR: "/bundle/pg-client/bin" }) },
          [`${PKG_BIN}/pg_dump`],
        ),
      ),
    ).toThrow(PgClientToolMissingError);
  });

  it("throws naming `bun install` when the package is not installed", () => {
    expect(() => resolvePgClientBin("pg_dump", ctx({}))).toThrow(
      /run `bun install`/,
    );
  });

  it("throws on an unsupported platform", () => {
    expect(() =>
      resolvePgClientBin("pg_dump", ctx({ platform: "win32", arch: "x64" })),
    ).toThrow(/unsupported platform win32\/x64/);
  });
});
