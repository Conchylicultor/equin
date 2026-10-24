# UI-driven Apple code-signing & notarization for Tauri releases

## Context

Today the Tauri macOS release path produces an **unsigned, un-notarized** `.app`/`.dmg`:
`release.ts` builds only the `.app` (`tauri build --bundles app`, `release.ts:626`) then hand-packages the dmg with `appdmg` (`packageMacDmg`, `release.ts:667`). There is no `bundle.macOS` block in `tauri/src-tauri/tauri.conf.json`, no `codesign`, no `notarytool`. So Gatekeeper warns on every download.

We want users to fix this **entirely from the UI** — no manual env-var export — via a guided wizard that mirrors the existing Google OAuth setup wizard, deep-linking to the right Apple Developer pages. Credentials are stored in the existing encrypted secrets store; the UI-triggered release reads them and injects them into the build.

### Decisions (confirmed with user)

| Topic | Choice |
|---|---|
| Notarization creds | **App Store Connect API key** (`.p8` + Key ID + Issuer ID) — modern, headless-friendly |
| Certificate | **Upload `.p12`** in the wizard (base64 → secret); Tauri imports it via `APPLE_CERTIFICATE` |
| Placement | **Accounts pane** — a new "Apple Developer" provider row beside Google/Notion |

### Why this works despite the gateway constraint

`secrets/server.getSecret` is an HTTP client to `localhost:9000`, so the **gateway must be up** to read creds. We sidestep the "CLI is gateway-free" problem entirely: the **release engine** (`plugins/release/server/internal/run-release.ts`) runs inside the worktree server runtime (gateway up), reads the creds there, and injects them as **env vars** onto its `Bun.spawn` of `./equin release`. The CLI/Tauri/notarytool inherit them — the CLI never touches the secrets store. Running `./equin release --target tauri` from a bare terminal simply stays unsigned (or the power-user exports `APPLE_*` manually, which Tauri reads natively) — graceful degradation, no hard failure.

---

## Architecture

```
Settings → Accounts → "Apple Developer" row ──▶ Apple setup wizard pane
                                                   │ (browser)
            ┌──────────────────────────────────────┘
            ▼  fetchEndpoint(...)  →  central secrets / config_v2  (encrypted at rest)
      apple-signing config-fields:  p12Cert*, p12Password*, ascApiKey*  (secret)
                                     signingIdentity, ascKeyId, ascIssuerId  (config_v2 text)

Studio → Run release (target=tauri)
   → POST /api/release → triggerRelease() → doRunRelease()   [worktree server, gateway up]
        │  collectReleaseEnv("tauri")  ──▶ apple-signing contributes APPLE_* env  (reads secrets)
        ▼
   Bun.spawn(["./equin","release","--target","tauri",...], { env: {...process.env, ...APPLE_*} })
        → wrapTauri(): `tauri build` (inherits env) signs .app  (APPLE_CERTIFICATE/_PASSWORD/_SIGNING_IDENTITY)
        → packageMacDmg(): appdmg → notarytool submit (.p8) → stapler staple   [new]
```

`* = secret (encrypted), shows only {set:boolean} to the browser.`

---

## Storage model

One config descriptor, mixing secret and non-secret fields (mirrors `googleAuthConfig` in `plugins/auth/plugins/google/shared/config.ts`):

```ts
// plugins/auth/plugins/apple-signing/shared/config.ts
export const appleSigningConfig = defineConfig({
  name: "apple-signing",
  fields: {
    p12Cert:       secretField({ label: "Developer ID certificate (.p12, base64)" }),
    p12Password:   secretField({ label: "Certificate password" }),
    ascApiKey:     secretField({ label: "App Store Connect API key (.p8 PEM)" }),
    signingIdentity: textField({ label: "Signing identity" }),   // derived from the .p12
    ascKeyId:        textField({ label: "API Key ID" }),
    ascIssuerId:     textField({ label: "API Issuer ID" }),
  },
});
```

| Field | Store | Env var consumed at release |
|---|---|---|
| `p12Cert` (base64 .p12) | secret → `config-fields/apple-signing.p12Cert` | `APPLE_CERTIFICATE` |
| `p12Password` | secret | `APPLE_CERTIFICATE_PASSWORD` |
| `signingIdentity` | config_v2 text | `APPLE_SIGNING_IDENTITY` |
| `ascApiKey` (.p8 PEM) | secret | written to temp `.p8` for notarytool |
| `ascKeyId` | config_v2 text | `--key-id` |
| `ascIssuerId` | config_v2 text | `--issuer` |

Secret fields automatically expose `{set:boolean}` to the browser through `configV2SecretMetaResource` (the wizard's done-gate, same as Google). Text fields are read in the browser via `useConfig(appleSigningConfig)`. Plaintext never flows back to the browser.

---

## New plugin: `plugins/auth/plugins/apple-signing/`

Sibling of `google`/`notion`, but **no central/OAuth** — there is no account to "connect", only credentials to configure. Structure:

- **`shared/config.ts`** — `appleSigningConfig` above.
- **`server/index.ts`**
  - `ConfigV2.Register({ descriptor: appleSigningConfig })` — surfaces fields + enables `setConfigField` persistence + the secret-meta resource.
  - Implements **`setAppleCertificateEndpoint`** (`POST /api/apple-signing/certificate`): body `{ p12Base64, password }`. Validates + **derives the signing identity** by shelling out to openssl:
    `openssl pkcs12 -in <tmp> -passin pass:<pw> -nokeys -clcerts -legacy | openssl x509 -noout -subject` → parse `CN=`. On success, persists `p12Cert`, `p12Password` (via the config secret-storage provider so the meta resource updates) and `signingIdentity` (config text), returns `{ signingIdentity }`. On parse failure, persists the secrets and returns `{ signingIdentity: null }` so the wizard reveals a manual identity input (resilient fallback).
  - Contributes the release-env entry: `Release.EnvProvider({ target: "tauri", provide: getAppleSigningEnv })` (see below).
  - Exports `getAppleSigningEnv(): Promise<Record<string,string> | null>` — reads the three secrets (`getSecret`) + three config texts (config_v2 server handle); returns the `APPLE_*` overlay, or `null` if incomplete.
- **`web/index.ts`**
  - `Auth.Provider({ id: "apple-signing", name: "Apple Developer", icon: SiApple, rowComponent: AppleProviderRow, configureCredentials: () => openPane(appleSetupPane, {}, { mode: "root" }) })`
  - `ConfigV2.WebRegister({ descriptor: appleSigningConfig })`
- **`web/components/apple-provider-row.tsx`** — custom row (the default row assumes an `authStateResource` entry, which we don't have). Derives status from `configV2SecretMetaResource` (`p12Cert.set && ascApiKey.set`) + `useConfig` (`signingIdentity && ascKeyId && ascIssuerId`): shows **Configure** (nothing set) / **Signing configured ✓ · Manage** (all set) / **Finish setup** (partial). Click → opens `appleSetupPane`.
- **`plugins/setup-wizard/web/`** — the wizard pane (see next), mirroring `plugins/auth/plugins/google/plugins/setup-wizard/`.

> Boundary note: `apple-signing` contributes to the generic `Auth.Provider` slot with a custom row, so it needs no central auth descriptor and never touches the OAuth token store. It is a config-only "provider".

---

## The wizard pane

`plugins/auth/plugins/apple-signing/plugins/setup-wizard/web/components/apple-setup-pane.tsx`, registered via `Pane.Register` with `defaultAncestors: [accountsPane]`. Copy the `Step`/`StepLink` components verbatim from `google-setup-pane.tsx` (numbered circle badges, `done` ✓ gating, external-link buttons). Steps:

| # | Title | Link / input |
|---|---|---|
| 1 | Enrolled in the Apple Developer Program | link → `https://developer.apple.com/account` (info only) |
| 2 | Create a **Developer ID Application** certificate | link → `https://developer.apple.com/account/resources/certificates/list` · caption: "Download it, then in Keychain Access → right-click → Export as `.p12` with a password." |
| 3 | **Upload certificate** | `<input type=file accept=".p12">` → read as base64 client-side + password `<Input type=password>` → `setAppleCertificateEndpoint`. Done when `p12Cert.set`; shows the derived identity (or reveals a manual identity input on derivation failure). |
| 4 | Create an **App Store Connect API key** | link → `https://appstoreconnect.apple.com/access/integrations/api` · caption: "Users and Access → Integrations → Keys → generate a key (Developer access). Download the `.p8` once; copy the Key ID and Issuer ID." |
| 5 | **Enter API key** | `<input type=file accept=".p8">` → `file.text()` → `setConfigField ascApiKey`; `<Input>`s for Key ID + Issuer ID → `setConfigField`. Done when `ascApiKey.set && ascKeyId && ascIssuerId`. |
| 6 | Ready to sign | success state once all done; note the next `tauri` release will be signed + notarized. |

Client-side file→base64 helper (no FileReader pattern exists in the repo — add inline): `btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))`. The `.p8` is PEM text → `await file.text()`, stored directly.

---

## Release-env injection (generic, decoupled)

Rather than coupling the generic release engine to `apple-signing`, the **release plugin owns a generic collection** and `apple-signing` is one contributor (collection-consumer separation):

- **`plugins/release/server`** defines a server contribution slot **`Release.EnvProvider`** carrying `{ target: string, provide: () => Promise<Record<string,string> | null> }`, and a helper `collectReleaseEnv(target)` that runs every contributor for that target and merges the non-null results. (Mirror an existing server-side registration collection, e.g. how `ConfigV2.Register` / MCP tools are collected.)
- **`run-release.ts`**: just before the spawn (`run-release.ts:179`), `const extraEnv = await collectReleaseEnv(target);` and set `env: extraEnv ? { ...process.env, ...extraEnv } : undefined` on the `Bun.spawn` options. Other targets get `{}` → unchanged behavior.
- `apple-signing/server` contributes the `"tauri"` entry returning the `APPLE_*` overlay. Release never names Apple; a future Windows/Authenticode signer just adds another contributor.

> Simpler fallback if the server-slot wiring proves disproportionate: a direct `import { getAppleSigningEnv } from "@plugins/auth/plugins/apple-signing/server"` in `run-release.ts`, gated on `target === "tauri"`. The generic slot is preferred per the project's "build the primitive" rule.

---

## CLI changes (`plugins/framework/plugins/cli/bin/commands/release.ts` + tauri config)

App signing is automatic once the env vars are present — `wrapTauri`'s `tauri build` already inherits them. Two concrete changes:

1. **`tauri/src-tauri/tauri.conf.json`** — add a `bundle.macOS` block so signed builds use hardened runtime (required for notarization):
   ```jsonc
   "macOS": { "hardenedRuntime": true, "entitlements": "entitlements.plist" }
   ```
   Add **`tauri/src-tauri/entitlements.plist`** — minimal hardened-runtime entitlements for a WKWebView app (start with `com.apple.security.cs.allow-jit`; tune if notarization flags more). Harmless when unsigned (codesign isn't invoked without an identity).

2. **`packageMacDmg` (`release.ts:667`)** — after `appdmg` writes the dmg (`release.ts:700`), add a guarded notarize+staple step:
   ```ts
   const keyPem = process.env.APPLE_API_KEY_PEM;
   if (keyPem && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER_ID) {
     // write the .p8 to a 0600 temp file (mkdtemp), then:
     await run(["xcrun","notarytool","submit",dmgOut,
       "--key",keyPath,"--key-id",process.env.APPLE_API_KEY_ID,
       "--issuer",process.env.APPLE_API_ISSUER_ID,"--wait"], { cwd: srcTauri });
     await run(["xcrun","stapler","staple",dmgOut], { cwd: srcTauri });
     // rm the temp .p8/dir
   } else {
     console.log("[tauri] No Apple API key in env — dmg left un-notarized.");
   }
   ```
   `getAppleSigningEnv` sets `APPLE_API_KEY_PEM` (the `.p8` contents), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID` (plus the three `APPLE_CERTIFICATE*`/`APPLE_SIGNING_IDENTITY` Tauri reads natively). The CLI writes the PEM to a temp file because `notarytool --key` wants a path.

---

## Files

**Create**
- `plugins/auth/plugins/apple-signing/{package.json, shared/config.ts, server/index.ts, web/index.ts, web/components/apple-provider-row.tsx}`
- `plugins/auth/plugins/apple-signing/server/internal/{certificate-endpoint.ts, signing-env.ts}` (endpoint + `getAppleSigningEnv`)
- `plugins/auth/plugins/apple-signing/core/endpoints.ts` (`setAppleCertificateEndpoint` definition)
- `plugins/auth/plugins/apple-signing/plugins/setup-wizard/{package.json, web/index.ts, web/panes.ts, web/components/apple-setup-pane.tsx}`
- `tauri/src-tauri/entitlements.plist`

**Modify**
- `tauri/src-tauri/tauri.conf.json` — add `bundle.macOS`.
- `plugins/framework/plugins/cli/bin/commands/release.ts` — notarize+staple in `packageMacDmg`.
- `plugins/release/core` + `plugins/release/server` — `Release.EnvProvider` slot + `collectReleaseEnv`.
- `plugins/release/server/internal/run-release.ts` — inject `collectReleaseEnv(target)` into the spawn env.

Run `./equin build` after — it regenerates the plugin registries, migrations, and docs.

---

## Verification

1. `./equin build`, open `http://<worktree>.localhost:9000` → Settings → Accounts. Confirm the **Apple Developer** row appears with a **Configure** CTA.
2. Open the wizard; verify all 6 steps render and external links point at the Apple pages above.
3. **Cert step** (needs a real Developer ID `.p12`): upload + password → confirm the derived `signingIdentity` displays and the step shows ✓. Verify via MCP: `query_db` won't show secrets (encrypted); instead check `POST /api/secrets/meta {namespace:"config-fields", key:"apple-signing.p12Cert"}` returns `{set:true}`, and `useConfig` shows `signingIdentity` populated.
4. **API-key step**: upload `.p8`, enter Key ID + Issuer ID → step ✓; row flips to **Signing configured ✓**.
5. **End-to-end signing** (needs a paid Apple account): Studio → Run release, target **Desktop (Tauri)**. After it finishes, on the artifact:
   - `codesign -dv --verbose=4 <app>` → shows the Developer ID authority + `flags=...(runtime)`.
   - `spctl -a -t open --context context:primary-signature -v <dmg>` and `xcrun stapler validate <dmg>` → accepted / stapled.
6. **Degradation**: with no creds configured, a Tauri release still completes and logs "left un-notarized" — no failure. Confirm non-tauri (web) releases are byte-identical to before (empty env overlay).

---

## Follow-ups / notes

- **Secret transport**: plaintext `.p12`/`.p8` travel browser→server over localhost and into a detached process env — same localhost trust model as the rest of the dev tooling; encrypted at rest in `~/.singularity/secrets.json.enc`. Worth a one-line acknowledgement in the wizard.
- **openssl `-legacy`**: macUS LibreSSL vs OpenSSL 3 differ on legacy PKCS#12. The derivation falls back to a manual identity field, so a parse miss never blocks setup.
- **CI**: out of scope here (no gateway in CI). The same `APPLE_*` env contract means a future CI path can export the vars directly without new plumbing.
- **Windows/Linux signing**: the `Release.EnvProvider` slot is the extension point — add a contributor, touch nothing in the engine.
