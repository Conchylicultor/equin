import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  exists,
  readFile,
  realpath,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  hostTarget,
  type DepSource,
  type DepTarget,
  type Ready,
} from "@plugins/infra/plugins/deps/deps";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

/** The npm updater's id (`infra/deps/npm`): what moves the package's version in bun.lock. */
const NPM_UPDATER = "npm";

/** Where the package sits inside an install's `env/`. */
const PACKAGE_DIR = "package";

const MINUTE = 60_000;

/** One npm package, copied out of a workspace's `node_modules`. */
export interface PackageCopySource extends DepSource<"package-copy"> {
  /** The repo-relative workspace whose `node_modules` holds the package. */
  readonly workspace: string;
  /** The package's name, for the host's target (`@embedded-postgres/darwin-arm64`). */
  readonly packageName: (target: DepTarget) => string;
  readonly updater: typeof NPM_UPDATER;
}

const PackageJsonSchema = z.object({ version: z.string() });

/**
 * The installer kind for an npm package something OUTSIDE the checkout runs —
 * a host daemon's native binary (Postgres, PgBouncer) — so the bytes it runs
 * are a copy no `bun install` in the checkout can replace under it.
 *
 * - **Identity**: the package's `bun.lock` entry (name, version, integrity)
 *   and the target. Another package moving in the lock is not a new install;
 *   a new version or build of this one is. Only the package itself is copied,
 *   so it must be self-contained (a native binary package, which declares no
 *   dependencies): one that does is refused rather than copied without them.
 * - **Install**: copy the package dir the workspace's `node_modules` resolves
 *   to (bun's store, through its link) into `env/package/`, after checking
 *   that what `node_modules` holds IS the version the lock names — a checkout
 *   whose install is behind its lock fails loudly rather than copying the
 *   wrong bytes under the right identity.
 * - **Staying current**: the npm updater moves the package's version in
 *   `bun.lock`; that is a new identity, installed when someone asks for it.
 * - Host only: the copy is of what this host's `bun install` fetched.
 */
export function npmPackageCopy(opts: {
  workspace: string;
  package: (target: DepTarget) => string;
  admission?: { readonly none: string };
}): PackageCopySource {
  const { workspace } = opts;
  const packageName = opts.package;
  return {
    kind: "package-copy",
    label: `an npm package from ${workspace}/node_modules`,
    workspace,
    packageName,
    updater: NPM_UPDATER,
    ...(opts.admission === undefined ? {} : { admission: opts.admission }),

    async identityInputs(root) {
      const target = hostTarget();
      const name = packageName(target);
      const { entries } = await lockEntry(root, name);
      const inputs: Record<string, string> = {
        target: `${target.platform}/${target.arch}`,
        package: name,
      };
      entries.forEach((e, i) => (inputs[`lock:${i}`] = e));
      return inputs;
    },

    async install(ctx) {
      const name = packageName(hostTarget());
      const { version } = await lockEntry(ctx.root, name);
      const linked = join(ctx.root, workspace, "node_modules", name);
      if (!(await exists(linked))) {
        throw new Error(
          `${name} is not installed at ${linked}: run \`bun install\` in ${ctx.root}`,
        );
      }
      const source = await realpath(linked);
      const found = await readVersion(source);
      if (found !== version) {
        throw new Error(
          `${linked} holds ${name}@${found}, but bun.lock names ${version}: run \`bun install\` in ${ctx.root}`,
        );
      }
      await mkdir(ctx.dir, { recursive: true });
      const dest = join(ctx.dir, PACKAGE_DIR);
      // `cp -R` keeps the package's symlinks (versioned dylib aliases) as
      // links and its files' modes (the executables).
      await ctx.run(["cp", "-R", source, dest], {
        cwd: ctx.root,
        env: { ...process.env },
        timeoutMs: 10 * MINUTE,
      });
      const copied = await readVersion(dest);
      if (copied !== version) {
        throw new Error(
          `the copy at ${dest} reads ${name}@${copied}, not ${version}: ${source} changed while it was copied`,
        );
      }
      ctx.log(`copied ${name}@${version} from ${source}`);
    },

    isIntact: (dir) => exists(join(dir, PACKAGE_DIR, "package.json")),
  };
}

const LockSchema = z.object({
  // `[ "<name>@<version>", registry, info, integrity ]`.
  packages: z.record(z.string(), z.array(z.unknown()).min(1)),
});

const InfoSchema = z
  .object({
    dependencies: z.record(z.string(), z.string()).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

/**
 * The package's `bun.lock` entry (canonical JSON, for the identity) and the
 * version it names. Read here rather than through the npm updater's lock
 * reader: this kind is imported by the database plugins every composition
 * loads, and the updater's subtree is not one they may drag in.
 */
async function lockEntry(
  root: string,
  name: string,
): Promise<{ entries: string[]; version: string }> {
  const errors: ParseError[] = [];
  const raw: unknown = parse(
    await readFile(join(root, "bun.lock"), "utf-8"),
    errors,
    { allowTrailingComma: true },
  );
  if (errors.length > 0) {
    throw new Error(
      `bun.lock in ${root} does not parse: ${errors.map((e) => `${printParseErrorCode(e.error)} at ${e.offset}`).join(", ")}`,
    );
  }
  const entry = LockSchema.parse(raw).packages[name];
  const spec = entry?.[0];
  const prefix = `${name}@`;
  if (
    entry === undefined ||
    typeof spec !== "string" ||
    !spec.startsWith(prefix)
  ) {
    throw new Error(
      `bun.lock in ${root} has no entry for ${name}: declare it in its workspace's package.json and run \`bun install\``,
    );
  }
  const info = InfoSchema.safeParse(entry[2] ?? {});
  const needs = info.success
    ? [
        ...Object.keys(info.data.dependencies ?? {}),
        ...Object.keys(info.data.optionalDependencies ?? {}),
        ...Object.keys(info.data.peerDependencies ?? {}),
      ]
    : [];
  if (needs.length > 0) {
    throw new Error(
      `${name} depends on ${needs.join(", ")}: a package copy carries the package alone, so it only copies a self-contained one`,
    );
  }
  return {
    entries: [JSON.stringify(entry)],
    version: spec.slice(prefix.length),
  };
}

async function readVersion(packageDir: string): Promise<string> {
  return PackageJsonSchema.parse(
    JSON.parse(await readFile(join(packageDir, "package.json"), "utf-8")),
  ).version;
}

/** The copied package's root (its `package.json` sits there). */
export function packageCopyDir(ready: Ready<PackageCopySource>): AppPath {
  return joinAppPath(ready.dir, PACKAGE_DIR);
}

/** The copied package's version, as its own `package.json` says. */
export async function packageCopyVersion(
  ready: Ready<PackageCopySource>,
): Promise<string> {
  return readVersion(packageCopyDir(ready));
}
