import type { DepTarget } from "@plugins/infra/plugins/deps/deps";
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { npmPackageCopy } from "@plugins/infra/plugins/deps/plugins/package-copy/deps";

/** `@embedded-postgres/<platform>`, the package carrying this target's server binaries. */
function serverPackage(target: DepTarget): string {
  const tags: Record<string, Record<string, string>> = {
    darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
    linux: { arm64: "linux-arm64", x64: "linux-x64" },
  };
  const tag = tags[target.platform]?.[target.arch];
  if (tag === undefined) {
    throw new Error(
      `pg: no embedded Postgres build for ${target.platform}/${target.arch}`,
    );
  }
  return `@embedded-postgres/${tag}`;
}

/**
 * The embedded cluster's server binaries (`postgres`, `initdb`, `pg_ctl` and
 * their libraries): a copy of this platform's `@embedded-postgres` package
 * outside the checkout, so a `bun install` that moves the package never
 * replaces the binary under the running postmaster, and the next start does
 * not silently run a new version.
 *
 * Pinned: the start script runs the install the pin holds; moving it is
 * `./equin deps pin postgres-binaries`, then a restart of the cluster.
 */
export const postgresBinaries = defineDep({
  id: "postgres-binaries",
  owner: "database/embedded/binaries",
  description:
    "The embedded Postgres server binaries the gateway runs the cluster from, copied out of the checkout and pinned",
  sizeHint: "≈330 MB",
  source: npmPackageCopy({
    workspace: "plugins/database/plugins/embedded",
    package: serverPackage,
    admission: {
      none: "the cluster's start waits on it (a file copy), and that start must never queue behind the background lane it unblocks",
    },
  }),
  pin: {
    holder: "machine-postgres",
    appliesAt:
      "the cluster's next full restart (a reattach keeps the running postmaster)",
  },
});

export default [postgresBinaries];
