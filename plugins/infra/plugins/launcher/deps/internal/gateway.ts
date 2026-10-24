import { join } from "node:path";
import {
  isSignedBy,
  machineHost,
  readConfiguredValue,
  readLocalIdentity,
  resolveConfigured,
  signBinary,
  type CodesignHost,
} from "@plugins/infra/plugins/codesign/deps";
import {
  defineDep,
  type DepTarget,
  type Ready,
} from "@plugins/infra/plugins/deps/deps";
import {
  build,
  builtFile,
  type BuildSource,
} from "@plugins/infra/plugins/deps/plugins/build/deps";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";

/**
 * The gateway's code-signing identifier: with the signing certificate, what
 * macOS keys the gateway's permission grants to (Downloads for the File
 * Explorer, …). The same as the launchd label, so the two read as one app.
 */
const GATEWAY_CODESIGN_IDENTIFIER = "dev.singularity.gateway";

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
 * beside the old one, and `./equin start` picks it up with no flag.
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
 *
 * A darwin build made on a Mac is code-signed as `dev.singularity.gateway` by
 * this machine's identity (`infra/codesign`), so macOS keeps its permission
 * grants across rebuilds — an ad-hoc binary is keyed by its hash, and every
 * rebuild was a new app to it. The identity is not part of the build's
 * identity; `signGateway` re-signs an installed binary when it changes.
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
    then: async (ctx, built) => {
      // Only a Mac signs, and only a binary for macOS.
      if (ctx.target.platform !== "darwin" || process.platform !== "darwin") {
        return;
      }
      await signBinary(built, {
        identifier: GATEWAY_CODESIGN_IDENTIFIER,
        exec: ctx.exec,
        log: ctx.log,
      });
    },
  }),
  updates: { none: "built from this checkout's own source" },
  bundle: "required",
});

/**
 * Make sure an installed gateway is signed by this machine's CURRENT identity —
 * what `./equin start` runs after `ensureDep`, which skips a ready install and
 * so never re-runs the build's signing step. A no-op when it already is (or off
 * macOS); otherwise re-signs in place, which is safe under a running gateway
 * (the signed copy is renamed over the file). Throws when a configured identity
 * cannot be resolved.
 */
export async function signGateway(
  gateway: Ready<BuildSource>,
  exec: ExecContext,
  log: (line: string) => void,
): Promise<void> {
  const outcome = await signBinary(builtFile(gateway), {
    identifier: GATEWAY_CODESIGN_IDENTIFIER,
    exec,
    log,
  });
  if (outcome.kind === "already-signed") {
    log(
      `Gateway signed by the ${outcome.identity.kind} identity "${outcome.identity.label}" (${outcome.identity.sha1})`,
    );
  }
}

/**
 * Whether the gateway binary at `path` carries the signature `signGateway`
 * would give it now — asked WITHOUT side effects (the local identity is read,
 * never minted; nothing is re-signed), for a reader that only reports.
 *
 * - `unsupported` — not macOS: nothing is signed there;
 * - `no-identity` — this machine has no local identity yet (the next `start`
 *   creates one and signs);
 * - `signed` / `unsigned` — by that identity, as `dev.singularity.gateway`.
 */
export async function gatewaySignature(
  path: string,
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
  return (await isSignedBy(path, GATEWAY_CODESIGN_IDENTIFIER, sha1, host))
    ? "signed"
    : "unsigned";
}
