import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "paths:no-hardcoded-paths",
    paths: [
      "deps/internal/identity.ts",
      "deps/internal/sign.ts",
      "deps/internal/codesign.test.ts",
    ],
    kind: "sanctioned",
    reason:
      "macOS system tools pinned by absolute path on purpose: Apple's `codesign` exists only at its system path, and the certificate must come from the system `openssl` (LibreSSL), never a Homebrew one first on PATH. These are OS fixtures, not install locations a paths constant could resolve.",
  },
] satisfies Exemptions;
