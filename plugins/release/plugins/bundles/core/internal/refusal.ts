import type { ReleaseManifest } from "./manifest";

/**
 * Every way bundle discovery can fail to name a shippable bundle, enumerated BY
 * NAME and carrying the values its message needs.
 *
 * A named case rather than a pre-rendered string because the two consumers want
 * different things from the same verdict: the CLI prints
 * {@link bundleRefusalMessage} verbatim and exits; an HTTP handler branches on
 * `kind` (a `platform-mismatch` is a "rebuild" affordance, a `no-releases` is a
 * "build one" affordance) and renders the same sentence beneath it.
 */
export type BundleRefusal =
  /** The `<comp>-web/` dir does not exist — nothing was ever released here. */
  | {
      kind: "no-releases";
      composition: string;
      platform: string;
      compDir: string;
      namespace: string;
    }
  /** An explicitly named `--release <run-id>` that is not on disk. */
  | {
      kind: "no-such-run";
      release: string;
      runDir: string;
      compDir: string;
      /** The run dirs that DO exist, for the "did you mean" line. */
      available: string[];
      namespace: string;
    }
  /** No `latest-<platform>` pointer — nothing packed has claimed this platform. */
  | {
      kind: "no-pointer";
      pointer: string;
      pointerPath: string;
      namespace: string;
    }
  /** The run dir exists but holds no `RELEASE.json`. */
  | { kind: "no-manifest"; runDir: string }
  | {
      kind: "wrong-composition";
      manifestPath: string;
      found: string;
      expected: string;
    }
  | { kind: "wrong-target"; manifestPath: string; found: string }
  | {
      kind: "platform-mismatch";
      manifestPath: string;
      found: string;
      expected: string;
    }
  | {
      kind: "inconsistent-run-id";
      manifestPath: string;
      declared: string;
      runId: string;
    }
  /** Staged (`--dev`) but never packed into a shippable binary. */
  | { kind: "not-packed"; localPath: string };

/**
 * The verdict of bundle discovery: the bundle to ship, or the named reason
 * there isn't one.
 *
 * A discriminated result rather than a `refuse()`-and-exit (what the CLI used
 * to do inline) because the same question is asked from an HTTP handler, which
 * cannot exit the process — and because a `null` here would be exactly the
 * absorbable failure the repo's rule forbids.
 */
export type BundleResolution =
  | {
      ok: true;
      runId: string;
      /** The self-extracting binary to ship. */
      localPath: string;
      /** Its name on disk — carries the platform, which is why the unit cannot. */
      binaryName: string;
      manifest: ReleaseManifest;
    }
  | { ok: false; refusal: BundleRefusal };

/**
 * The hint every bundle-discovery refusal carries: which namespace was searched,
 * and the one way the answer can be "it exists, but not here".
 */
export function namespaceHint(namespace: string): string {
  return (
    `Release namespace: "${namespace}" (a backend's own namespace, or the one ` +
    `this checkout owns when run from the CLI). A release cut from another ` +
    `namespace lands under that one instead, and ship deliberately does not ` +
    `search a second one.`
  );
}

/**
 * The user-facing sentence for a refusal. This is the ONE spelling of that
 * wording — the CLI prints it under its own `deploy: ` prefix and a UI renders
 * it verbatim, so a refusal never says two different things in two places.
 */
export function bundleRefusalMessage(refusal: BundleRefusal): string {
  switch (refusal.kind) {
    case "no-releases":
      return (
        `no release of "${refusal.composition}" found. Looked in:\n  ${refusal.compDir}\n` +
        `${namespaceHint(refusal.namespace)}\n` +
        `Build one: ./equin release --composition ${refusal.composition} --target web --platform ${refusal.platform}`
      );
    case "no-such-run":
      return (
        `release run "${refusal.release}" does not exist. Looked in:\n  ${refusal.runDir}\n` +
        `Available runs in ${refusal.compDir}: ${
          refusal.available.length > 0
            ? [...refusal.available].sort().join(", ")
            : "(none)"
        }\n` +
        namespaceHint(refusal.namespace)
      );
    case "no-pointer":
      return (
        `no \`${refusal.pointer}\` release pointer. Looked for:\n  ${refusal.pointerPath}\n` +
        `${namespaceHint(refusal.namespace)}\n` +
        `Pass --release <run-id> to name a run explicitly.`
      );
    case "no-manifest":
      return `${refusal.runDir} holds no RELEASE.json — it is not a complete release run.`;
    case "wrong-composition":
      return `${refusal.manifestPath} was built for composition "${refusal.found}", not "${refusal.expected}".`;
    case "wrong-target":
      return `${refusal.manifestPath} is a "${refusal.found}" release; only the \`web\` target is shippable to a server.`;
    case "platform-mismatch":
      return (
        `platform mismatch: ${refusal.manifestPath} is ${refusal.found}, but the server reports ` +
        `${refusal.expected}. Rebuild with --platform ${refusal.expected}.`
      );
    case "inconsistent-run-id":
      return `${refusal.manifestPath} declares runId "${refusal.declared}" but sits in "${refusal.runId}" — the release dir is inconsistent.`;
    case "not-packed":
      return `${refusal.localPath} is missing — that release was staged (\`--dev\`) but never packed into a shippable binary.`;
  }
}
