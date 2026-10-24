# Google OAuth Setup Wizard

## Context

The current Google auth "Configure credentials" button opens the generic Settings pane — two unlabelled text fields with no guidance. Users must independently find the right Google Cloud Console pages, understand the Desktop app credential type, and copy the redirect URI manually. The gap between "button clicked" and "working credentials" is entirely undocumented in the UI.

This plan replaces that flow with an interactive setup wizard side pane. The user pastes any GCP console URL (or types a project ID), and every step gets a direct deep-link to the exact GCP page. The credential fields and OAuth connect button live at the end of the same pane — one surface, zero navigation.

---

## Architecture

### 1. Extend `AuthProviderContribution` slot (one field)

**File:** `plugins/auth/web/slots.ts`

Add a single optional callback to `AuthProviderContribution`:

```ts
configureCredentials?: () => void;
```

**File:** `plugins/auth/web/components/default-provider-row.tsx`

The existing "Configure credentials" button currently calls `settingsPane.open({})` unconditionally. Change it to:

```ts
onClick={() => contribution.configureCredentials
  ? contribution.configureCredentials()
  : settingsPane.open({})
}
```

This keeps all other providers working with no changes and gives Google (and future providers) a clean override point without row-component duplication.

### 2. New sub-plugin: `plugins/auth/plugins/google/plugins/setup-wizard/`

The setup wizard is not load-bearing — it's an optional UX enhancement that lives as its own sub-plugin under the Google auth umbrella. This keeps `plugins/auth/plugins/google/web/` lean.

Structure:
```
plugins/auth/plugins/google/plugins/setup-wizard/
  web/
    index.ts          ← definePlugin; contributes Auth.Provider override + Pane.Register
    panes.ts          ← googleSetupPane definition
    components/
      google-setup-pane.tsx
  package.json
```

**`panes.ts`:**

```ts
import { accountsPane } from "@plugins/auth/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";

export const googleSetupPane = Pane.define({
  id: "google-setup",
  parent: accountsPane,
  path: "google/setup",
  component: GoogleSetupPane,
  chrome: { title: "Connect Google", history: false, close: true },
});
```

Full URL: `/accounts/google/setup` — opens as a second Miller column alongside the Accounts pane.

**`web/index.ts`** contributes:
- `Pane.Register({ pane: googleSetupPane })`
- `Auth.Provider({ id: "google", configureCredentials: () => googleSetupPane.open({}) })` — this partial contribution overrides only the `configureCredentials` callback; it does not re-declare icon/name (those come from the parent google plugin's contribution)

Wait — `Auth.Provider` contributions are keyed by `id`. Two contributions with the same `id: "google"` would conflict unless the slot supports merging. The cleaner approach: the sub-plugin does **not** contribute a second `Auth.Provider`. Instead, the parent `plugins/auth/plugins/google/web/index.ts` imports `googleSetupPane` from the sub-plugin barrel and sets `configureCredentials` directly in its existing `Auth.Provider` contribution.

**Revised wiring:**

- `plugins/auth/plugins/google/plugins/setup-wizard/web/index.ts` — contributes only `Pane.Register({ pane: googleSetupPane })`; exports `googleSetupPane` from its barrel
- `plugins/auth/plugins/google/web/index.ts` — imports `googleSetupPane` from `@plugins/auth/plugins/google/plugins/setup-wizard/web` and adds `configureCredentials: () => googleSetupPane.open({})` to the existing `Auth.Provider` contribution

The sub-plugin is registered in `web/src/plugins.ts` alongside the other google auth plugins.

The `Config.Spec(googleAuthConfig)` contribution stays in the parent google plugin — Settings remains a power-user fallback.

---

## Wizard Component

**New file:** `plugins/auth/plugins/google/plugins/setup-wizard/web/components/google-setup-pane.tsx`

### Project ID input (top of pane)

A single text input labelled "GCP Project ID". On change, extract the project ID from any pasted GCP URL before storing it:

```ts
const match = raw.match(/[?&]project=([^&#]+)/);
const id = match ? match[1] : raw.trim();
```

This handles pasting `https://console.cloud.google.com/apis/credentials?project=my-proj-123` directly without forcing users to know where the ID lives.

A small hint below the input: *"Paste any GCP console URL, or type your project ID"*

### Steps (rendered as a numbered list)

Each step has: number badge, title, description text, and an "Open →" button. Steps 2–5 have their button disabled/greyed when `projectId === ""`. Step 6 (connect) is always active once credentials are saved.

| # | Title | Button URL |
|---|---|---|
| 1 | Select or create a GCP project | `https://console.cloud.google.com/projectcreate` (no project ID needed) |
| 2 | Enable Google Drive API | `https://console.cloud.google.com/apis/library/drive.googleapis.com?project=<id>` |
| 3 | Set up OAuth consent screen | `https://console.cloud.google.com/auth/overview?project=<id>` |
| 4 | Create OAuth 2.0 credentials | `https://console.cloud.google.com/auth/clients/create?project=<id>` |
| 5 | Enter credentials | (no external link — inline form below) |
| 6 | Connect your account | (no external link — connect button below) |

**Step 4 detail:** Below the button, show the redirect URI the user must paste into GCP, as a monospace chip with a one-click copy button:
```
http://localhost:9000/api/auth/callback/google  [Copy]
```
Also note: *"Application type: Desktop app"*

**Step 5 detail (inline form):** Two password inputs for Client ID and Client Secret, and a Save button. On save, call:
```ts
await setConfigValue("auth-google.clientId", clientId);
await setConfigValue("auth-google.clientSecret", clientSecret);
```
Fields use `useSecretFieldSet("auth-google.clientId")` to show a "✓ Already configured" badge if a value is already stored (the actual value is never readable from the browser for secrets). The Save button is disabled when both fields are empty.

**Step 6 detail:** A "Connect with Google" button that calls `startConnectFlow({ providerId: "google", worktree: currentWorktreeName() })`. On success, show a success state in-pane and a green "Connected" badge. On error, show the error message inline.

### Visual state

Steps should visually communicate progress:
- Steps before project-ID-entry: opacity-50, button disabled
- Steps where prerequisite is met: full opacity, button active
- Step 5 after save: shows ✓ credential badge
- Step 6 after connect: shows ✓ connected state (read from `useAccountStatus("google").connected`)

---

## Files

| Action | Path |
|---|---|
| Modify | `plugins/auth/web/slots.ts` |
| Modify | `plugins/auth/web/components/default-provider-row.tsx` |
| Modify | `plugins/auth/plugins/google/web/index.ts` |
| Modify | `web/src/plugins.ts` |
| Create | `plugins/auth/plugins/google/plugins/setup-wizard/web/index.ts` |
| Create | `plugins/auth/plugins/google/plugins/setup-wizard/web/panes.ts` |
| Create | `plugins/auth/plugins/google/plugins/setup-wizard/web/components/google-setup-pane.tsx` |
| Create | `plugins/auth/plugins/google/plugins/setup-wizard/package.json` |

### Key imports to use
- `setConfigValue`, `useSecretFieldSet` from `@plugins/config/web`
- `useAccountStatus`, `startConnectFlow`, `currentWorktreeName`, `accountsPane` from `@plugins/auth/web`
- `googleSetupPane` from `@plugins/auth/plugins/google/plugins/setup-wizard/web` (in google parent index only)
- `Pane`, `PaneChrome` from `@plugins/primitives/plugins/pane/web`

---

## Out of scope

- Making the API-enable step extensible (consumer plugins contributing their required APIs). The Drive API step is hardcoded for now; this can become a `GoogleSetup.RequiredApi` slot later.
- A completion redirect after connect (close the wizard or stay open is fine for v1).
- Removing `Config.Spec(googleAuthConfig)` from Settings — keep it as a power-user path.

---

## Verification

1. `./equin build` succeeds, no type errors
2. Open `http://att-1777921323-1v3r.localhost:9000` → Accounts sidebar → Google row shows "Setup required"
3. Click "Configure credentials" → second Miller column opens with the wizard
4. Type/paste a GCP project URL → project ID is extracted, all step buttons become active
5. Copy the redirect URI chip → clipboard contains `http://localhost:9000/api/auth/callback/google`
6. Fill in Client ID + Client Secret → Save → both `useSecretFieldSet` badges flip to ✓
7. Click "Connect with Google" → OAuth popup opens → after approval, step 6 shows "Connected"
8. Close and reopen the wizard → credential fields show "Already configured", step 6 shows "Connected"
9. Settings pane still shows the Google credential fields as a fallback
