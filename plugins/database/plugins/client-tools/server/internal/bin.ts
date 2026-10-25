import {
  envName,
  readEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The client tools this plugin ships. Closed on purpose: a tool that is not
 * vendored has no spelling, so it cannot quietly fall through to the PATH.
 */
export type PgClientTool = "pg_dump" | "pg_restore";

const PLATFORMS: Record<string, Record<string, string>> = {
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  linux: { arm64: "linux-arm64", x64: "linux-x64" },
};

/** The vendored binary a caller asked for is not on disk. */
export class PgClientToolMissingError extends Error {
  constructor(
    readonly tool: PgClientTool,
    readonly path: string,
    fix: string,
  ) {
    super(`${tool}: vendored binary not found at ${path}; ${fix}`);
    this.name = "PgClientToolMissingError";
  }
}

export interface ResolveContext {
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
  /** This plugin's folder, whose `node_modules` holds the platform package. */
  pluginRoot: string;
  exists: (path: string) => boolean;
}

/**
 * Where `tool` lives, or a throw naming why it is not there.
 *
 * Never the PATH. A PATH lookup is what made Homebrew a prerequisite and let
 * the client drift from the server (an 18.6 client against the 18.3 cluster);
 * the vendored build comes from the same Postgres release as the server.
 */
export function resolvePgClientBin(
  tool: PgClientTool,
  ctx: ResolveContext,
): string {
  // Set by the release launcher to the bundle's vendored `pg-client/bin`.
  const override = readEnv("PG_CLIENT_BIN_DIR", ctx.env);
  if (override) {
    const bin = join(override, tool);
    if (!ctx.exists(bin)) {
      throw new PgClientToolMissingError(
        tool,
        bin,
        `${envName("PG_CLIENT_BIN_DIR")} points at ${override}, which the release bundle should have vendored it into`,
      );
    }
    return bin;
  }
  const platform = PLATFORMS[ctx.platform]?.[ctx.arch];
  if (!platform) {
    throw new Error(
      `${tool}: unsupported platform ${ctx.platform}/${ctx.arch} — @equin/pg-client ships darwin/linux × arm64/x64`,
    );
  }
  const bin = join(
    ctx.pluginRoot,
    "node_modules",
    `@equin/pg-client-${platform}`,
    "native",
    "bin",
    tool,
  );
  if (!ctx.exists(bin)) {
    throw new PgClientToolMissingError(tool, bin, "run `bun install`");
  }
  return bin;
}

const resolved = new Map<PgClientTool, string>();

/** Absolute path of the vendored `tool` for this process. */
export function pgClientBin(tool: PgClientTool): string {
  let bin = resolved.get(tool);
  if (bin === undefined) {
    bin = resolvePgClientBin(tool, {
      env: process.env,
      platform: process.platform,
      arch: process.arch,
      pluginRoot: join(import.meta.dir, "..", ".."),
      exists: existsSync,
    });
    resolved.set(tool, bin);
  }
  return bin;
}
