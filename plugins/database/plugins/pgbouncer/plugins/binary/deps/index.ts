import type { DepTarget } from "@plugins/infra/plugins/deps/deps";
import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { npmPackageCopy } from "@plugins/infra/plugins/deps/plugins/package-copy/deps";

/** `@equin/pgbouncer-<platform>`, the package carrying this target's binary. */
function pgbouncerPackage(target: DepTarget): string {
  const tags: Record<string, Record<string, string>> = {
    darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
    linux: { arm64: "linux-arm64", x64: "linux-x64" },
  };
  const tag = tags[target.platform]?.[target.arch];
  if (tag === undefined) {
    throw new Error(
      `pgbouncer: no PgBouncer build for ${target.platform}/${target.arch}`,
    );
  }
  return `@equin/pgbouncer-${tag}`;
}

/**
 * The PgBouncer binary: a copy of this platform's `@equin/pgbouncer` package
 * outside the checkout, so a `bun install` that moves the package never
 * replaces the binary under the running daemon, and the next start does not
 * silently run a new version.
 *
 * Pinned: the start script runs the install the pin holds; moving it is
 * `./equin deps pin pgbouncer-binary`, then a restart of PgBouncer.
 */
export const pgbouncerBinary = defineDep({
  id: "pgbouncer-binary",
  owner: "database/pgbouncer/binary",
  description:
    "The PgBouncer binary the gateway runs the pooler from, copied out of the checkout and pinned",
  sizeHint: "≈0.5 MB",
  source: npmPackageCopy({
    workspace: "plugins/database/plugins/pgbouncer",
    package: pgbouncerPackage,
    admission: {
      none: "PgBouncer's start waits on it (a one-file copy), and that start must never queue behind the background lane",
    },
  }),
  pin: {
    holder: "machine-pgbouncer",
    appliesAt: "PgBouncer's next start (a reattach keeps the running daemon)",
  },
});

export default [pgbouncerBinary];
