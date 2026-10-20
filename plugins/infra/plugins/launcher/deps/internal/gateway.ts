import { join } from "node:path";
import { defineDep, type DepTarget } from "@plugins/infra/plugins/deps/deps";
import { build } from "@plugins/infra/plugins/deps/plugins/build/deps";

/** Go's spelling of a target (GOOS / GOARCH). */
function goTarget(target: DepTarget): { GOOS: string; GOARCH: string } {
  const GOARCH =
    target.arch === "x64" ? "amd64" : target.arch === "arm64" ? "arm64" : null;
  if (
    (target.platform !== "darwin" && target.platform !== "linux") ||
    GOARCH === null
  ) {
    throw new Error(
      `the gateway builds for darwin and linux on x64 or arm64, not ${target.platform}/${target.arch}`,
    );
  }
  return { GOOS: target.platform, GOARCH };
}

/**
 * The gateway: `go build` of this checkout's `gateway/` module into the deps
 * cache. Its identity is every Go source plus `go.mod` / `go.sum`, the Go
 * version and the target, so editing a `.go` file (or a new Go) is a new build
 * beside the old one, and `./singularity start` picks it up with no flag.
 *
 * Cross-compiles to every release platform (`targets: "any"`), which is how a
 * release seals it for a Linux server from a Mac. It is pure Go on every
 * target (CGO_ENABLED=0), so building it needs Go and nothing else: Go's own
 * linker writes the binary, never the host's C toolchain. With cgo on, a
 * darwin build links through `clang` + `ld` against the Command Line Tools
 * SDK, and an install fails outright whenever those disagree — an `ld` older
 * than its SDK rejects the SDK's `.tbd` stubs (`tapi error: unknown
 * architecture arm64e.x1`), on a machine where Go itself is fine. On Linux it
 * also makes a static binary that depends on no glibc version on the
 * production host. So the gateway module must stay cgo-free: a file importing
 * "C" is silently left out of this build.
 *
 * Admitted like any install (one background unit): a cold `go build` is tens
 * of seconds of CPU.
 */
export const gatewayBinary = defineDep({
  id: "gateway-binary",
  owner: "infra/launcher",
  description:
    "The Go gateway: the front door on port 9000 that routes every namespace and supervises Postgres, PgBouncer and the backends",
  sizeHint: "≈15 MB",
  source: build({
    inputs: ["gateway/**/*.go", "gateway/go.mod", "gateway/go.sum"],
    tool: { versionArgv: ["go", "version"] },
    output: "gateway",
    targets: "any",
    run: async (ctx) =>
      ctx.run(["go", "build", "-o", ctx.output, "."], {
        cwd: join(ctx.root, "gateway"),
        env: {
          ...process.env,
          ...goTarget(ctx.target),
          CGO_ENABLED: "0",
        },
        timeoutMs: 15 * 60_000,
      }),
  }),
  updates: { none: "built from this checkout's own source" },
  bundle: "required",
});
