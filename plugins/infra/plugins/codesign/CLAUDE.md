# codesign

Stable code signing for the code this machine builds — the Go gateway, and the
equin app bundle every login service runs from on macOS (`signBundle`,
`registerApp`; see `infra/launcher/login-services`). macOS keys permission grants (Files & Folders, …) to a binary's
**designated requirement**. An ad-hoc, linker-signed binary (`Identifier=a.out`)
is keyed by its hash, so every gateway rebuild used to drop its grants and leave
one more stale "gateway" row in System Settings. Signing with a stable identity
and identifier gives a requirement that stays the same across rebuilds.

Design: [`research/2026-10-24-global-macos-permissions.md`](../../../../research/2026-10-24-global-macos-permissions.md), section 3.

```ts
import { signBinary } from "@plugins/infra/plugins/codesign/deps";

// in a build's `then` (infra/deps/build) or a CLI command — needs an ExecContext
const outcome = await signBinary(path, { identifier: "dev.example.tool", exec, log });
// → unsupported (not macOS) | already-signed (no-op) | signed

// an app bundle, IN PLACE: the caller signs a staged copy and swaps it in
await signBundle(staging, { identifier: "dev.equin", tool: { exec } /* or { installed: rcodesignReady } */ });
await registerApp(bundle); // lsregister -f: tccutil and System Settings resolve its bundle id
```

`signBundle` signs every executable in `Contents/MacOS` (rcodesign does the
nested ones itself; with a configured identity each is `codesign`ed first, under
its own name) and verifies the bundle against the requirement; its identifier
must be the bundle's `CFBundleIdentifier`. `rcodesign` comes from an
`RcodesignTool`: `{ exec }` installs it on demand, `{ installed }` is a `Ready`
a serving backend waited for through `deps` (it may not install on its event
loop). `codeSignature(path, identifier)` asks whether a binary or bundle is
signed by this machine's identity, without side effects (the drift row).

## Which identity

`resolveSigningIdentity()` gives `null` off macOS, otherwise one of two:

1. **Configured**: `EQUIN_CODESIGN_IDENTITY`, or else the file
   `~/.singularity/state/codesign/identity`. It holds a certificate SHA-1 or
   the exact name of a **valid** keychain identity, e.g. your
   "Developer ID Application: …" or "Apple Development: …". It is resolved
   with `security find-identity -v -p codesigning` and signed with
   `/usr/bin/codesign`. If it is missing, ambiguous, or not valid (expired,
   untrusted), it **throws**. It never falls back, because a different signer
   drops every grant. It is an env var or file, not config_v2, because
   `./equin start` and `deps install` run without a backend. The env var is
   forwarded to backends (`launcher/core` runtime-env), because a backend's
   `deps.install` job can build the gateway too.
2. **Local** (the default, for anyone without an Apple certificate): the
   machine's own self-signed certificate, "equin Local Code Signing".
   It lasts 20 years, has the codeSigning extended key usage, and is made by
   `/usr/bin/openssl`. It lives in `state/codesign/local/{cert,key}.pem`, with
   the directory at 0700 and the key at 0600. It is created on first use,
   under a flock, into a temp directory that is then renamed into place. It is
   signed with **`rcodesign`** (the `rcodesign` dependency, a pinned
   apple-codesign release) straight from the PEM files, with no timestamp.

### Why not a keychain for the local identity

The Step 0 spike (macOS 26.4) used a throwaway keychain with the identity
imported, `-T /usr/bin/codesign` or `-A`, and `set-key-partition-list`.
`codesign --sign <sha1> --keychain <kc>` still fails with
`no identity found`. `/usr/bin/codesign` uses only *valid* identities, and
probably also only keychains on the search list. A self-signed certificate is
`CSSMERR_TP_NOT_TRUSTED` until someone changes trust settings or the user's
keychain search list, and this plugin must never touch either.
`rcodesign` needs neither. Apple's verifier accepts its signatures:
`codesign -v` passes, and the designated requirement is
`identifier "…" and certificate root = H"<sha1>"`. For a self-signed
certificate the root is the leaf, so this requirement is stable across
rebuilds and re-signs.

## signBinary

- It is idempotent. It first checks `codesign -v -R='identifier "<id>" and
  certificate leaf = H"<sha1>"'`. If that passes, the file is left untouched.
- It signs a **copy** beside the file and renames the copy over it. `rcodesign`
  rewrites a file in place (same inode), which a running process should never
  see. After the rename, the running gateway keeps its old pages. The spike
  confirmed that a running process survives a re-sign done this way.
- After signing it checks that same requirement, and throws if it does not
  hold. It adds no hardened runtime and no entitlements.

## The gateway

`infra/launcher`'s `gateway-binary` passes `then: signBinary(built,
{ identifier: GATEWAY_CODESIGN_IDENTIFIER })` to `build()` for darwin targets
built on a Mac. The signing identity is **not** part of the dependency's
identity: it finishes a build, it does not change what was built. That
signature serves a gateway run where it was built (`serve-app`, a release). The
machine's own gateway (`./equin start`) runs from the equin app bundle
(`dev.equin`), signed as a whole by `signBundle`, and re-signed by `start` when
the identity changed.

## Resetting

`./equin codesign status` prints the identity in use, and creates nothing.
`./equin codesign reset` deletes `local/`. The next `./equin start` creates a
new certificate and re-signs the equin app. macOS then treats it as a new app:
grants are lost once. One app's decision is reset on its own by bundle id,
`tccutil reset SystemPolicyDownloadsFolder dev.equin` (`All` for every service);
that needs a bundle LaunchServices knows (`registerApp`). A bare executable
(the gateway before it ran from the bundle) has no bundle id: its rows can only
be removed by hand in System Settings → Privacy & Security, and
`tccutil reset <Service>` alone resets every app. Never run either
automatically.

## Check

`codesign:identity` is host-scoped, so only a standalone `./equin check` runs
it and it never fails a build. It fails when a configured identity does not
resolve, when the local identity is half-present, or when the signing
certificate expires within 30 days.

## Not done (follow-ups)

- **Release launcher**: a release built on a Mac seals the gateway from the
  same cache, signed with whichever identity that Mac has. If that is a local
  identity, the release carries a signature by an untrusted self-signed
  certificate, which is no worse than ad-hoc for other users. The plan's
  "copy the gateway to a stable path and re-sign it with this machine's
  identity" is not implemented in `bin/launch.ts` yet.
- `serve-app` relies on the build's `then`, and does not re-sign an existing
  install when the identity changes.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Stable code signing for the binaries this machine builds (the gateway): signBinary signs with a configured keychain identity (/usr/bin/codesign) or the machine's own self-signed one (PEM under state/codesign, via the pinned rcodesign dependency), so macOS permission grants survive rebuilds.
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps.ensureDep`
    - `infra/deps.Ready`
    - `infra/deps/download.download`
    - `infra/deps/download.downloadedFile`
    - `infra/deps/download.DownloadSource`
  - Exports (types):
    - `CodesignHost`
    - `CommandResult`
    - `ConfiguredValue`
    - `LocalIdentityState`
    - `RcodesignTool`
    - `SigningIdentity`
    - `SignOutcome`
  - Exports (values):
    - `codeSignature`
    - `configuredIdentityFile`
    - `configuredValidTo`
    - `isSignedBy`
    - `LOCAL_IDENTITY_NAME`
    - `localIdentityPaths`
    - `machineHost`
    - `rcodesign`
    - `readConfiguredValue`
    - `readLocalIdentity`
    - `registerApp`
    - `RESET_HINT`
    - `resolveConfigured`
    - `resolveSigningIdentity`
    - `signBinary`
    - `signBundle`
    - `signedByRequirement`
- Cross-plugin:
  - Imported by: `infra/launcher`
- Exemptions:
  - Exempts itself from: `paths:no-hardcoded-paths` — `deps/internal/identity.ts`, `deps/internal/sign.ts`, `deps/internal/codesign.test.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
