import { join } from "node:path";
import {
  codeSignature,
  machineHost,
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
import {
  componentIdentity,
  type AppComponent,
  type ComponentBuild,
} from "@plugins/infra/plugins/launcher/plugins/login-services/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

/**
 * The bare gateway binary's code-signing identifier: with the signing
 * certificate, what macOS keys its permission grants to when it runs where it
 * was built (`serve-app`, a release built on a Mac). The machine's own gateway
 * runs from the equin app bundle instead (`GATEWAY_APP_COMPONENT`), whose
 * grants are the app's.
 */
const GATEWAY_CODESIGN_IDENTIFIER = LEGACY_IDS.codesignIdentifier;

/**
 * The gateway as a program of the equin app: `equin.app/Contents/MacOS/gateway`
 * on macOS (login-services' `macos-app`), so the backends' file access — which
 * macOS charges to the gateway that started them — asks, and is granted, as
 * "equin". Named `gateway` there too, so its process name is unchanged.
 */
export const GATEWAY_APP_COMPONENT: AppComponent = { name: "gateway" };

/** An installed gateway build, as the component the app bundle installs. */
export function gatewayBuild(gateway: Ready<BuildSource>): ComponentBuild {
  return {
    file: builtFile(gateway),
    identity: componentIdentity(gatewayBinary.id, gateway.identity),
  };
}

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
 * A darwin build made on a Mac is code-signed as `GATEWAY_CODESIGN_IDENTIFIER` by
 * this machine's identity (`infra/codesign`), so macOS keeps its permission
 * grants across rebuilds — an ad-hoc binary is keyed by its hash, and every
 * rebuild was a new app to it. The identity is not part of the build's
 * identity. That signature serves a gateway run where it was built
 * (`serve-app`, a release); the machine's own gateway runs from the equin app
 * bundle, which `./equin start` installs it into and signs as a whole.
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
 * Whether the BARE gateway binary at `path` carries the signature its build
 * gives it (`then`, as `dev.singularity.gateway`) — asked WITHOUT side effects (the local identity is read,
 * never minted; nothing is re-signed), for a reader that only reports.
 *
 * - `unsupported` — not macOS: nothing is signed there;
 * - `no-identity` — this machine has no local identity yet (the next build
 *   creates one and signs);
 * - `signed` / `unsigned` — by that identity, as `GATEWAY_CODESIGN_IDENTIFIER`.
 */
export async function gatewaySignature(
  path: string,
  host: CodesignHost = machineHost(),
): Promise<"unsupported" | "no-identity" | "signed" | "unsigned"> {
  return codeSignature(path, GATEWAY_CODESIGN_IDENTIFIER, host);
}
