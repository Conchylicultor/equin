# API-key Claude accounts — run agents on the plan's monthly API credit

## Context

Max 5x / Max 20x / Team plans include a monthly Claude API credit ($100 / $200 /
up to $500), claimed by linking a Console org (claude.ai → Settings → Billing →
API credits) and spent through an **API key** — it covers the API and the Agent
SDK, not the plan's own Claude Code usage, and expires each cycle with no
rollover ([docs](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)).
equin's agents run on Claude accounts (`infra/claude-cli/accounts`) that are
subscription sign-ins only: the computer's login, or `claude setup-token` tokens
handed to Claude Code as `CLAUDE_CODE_OAUTH_TOKEN`. An API key pasted there today
passes the `sk-ant-…` shape check and then fails to sign in.

Goal: an API key is a first-class account kind, and with auto-switch on it is
the **overflow** — used only while every plan account is at its limit, and left
again as soon as one has room.

## Design

### One credential, its kind derived (accounts/core)

- `CLAUDE_CREDENTIALS` — the closed table of credential kinds as data:
  `token` (prefix `sk-ant-oat`, env `CLAUDE_CODE_OAUTH_TOKEN`) and `api-key`
  (prefix `sk-ant-api`, env `ANTHROPIC_API_KEY`). `claudeCredentialKind(secret)`
  derives the kind from the prefix; nothing else ever names it (an admin key or
  anything else is refused by `ClaudeCredentialSchema`).
- `claudeCredentialEnv(base, credential)` — `base` with every credential
  variable of the table removed and the one this kind uses set, so a stray host
  variable can never sign an agent into a different account than the picked one.
- `ClaudeAccountSchema` gains `kind` (`default("token")`: files written before
  this change hold token accounts only).
- `claudeAccountRefs(state)` — `{ id, metered }` per account, system first;
  `metered` = billed per use (an API key), with no plan windows.
- The add endpoint's body is `{ name, credential }`; the store derives `kind`.

### The agent's sign-in (accounts/server)

`claudeAccountToken(id): string | null` → `claudeAccountCredential(id):
ClaudeCredential | null` (`{ kind, secret }`, kind derived from the secret).
Its two consumers — `runtime-sdk/bin/agent.ts` and `machine/internal/usage-probe.ts`
— build Claude Code's env through `claudeCredentialEnv`. The env-var choice is
therefore inexpressible at the call sites.

The `chrome-needs-system-account` guard fires on any credential variable (an API
key carries no claude.ai sign-in either).

### Overflow, not drain (runtime-sdk/core usage-limits)

`launchAccount` / `roomiestAccount` take `LaunchCandidate { id, metered }`:

- `roomiestAccount`: plan accounts by weekly room (as today); a metered account
  only when no plan account can run.
- `launchAccount` with auto-switch on: on a metered active account, go back to
  the roomiest plan account that can run (else stay). Without this, the
  overflow would become `active` (`chooseLaunchAccount` selects it) and, never
  reporting a full limit, keep every later agent on the credit until it is gone.
  Auto-switch off: the active account, whatever it is (the user's explicit pick).

### UI (runtime-sdk/web claude-accounts.tsx)

- Row detail: `Token` / `API key · API credit`; the right column of a metered
  account reads "Billed to API credit" instead of the weekly bar (no plan limits
  to read, so no usage probe on add/switch for it).
- "Add account" becomes two entries: **Add plan account** (today's
  `claude setup-token` form) and **Add API key**, whose steps are: claim the
  plan's API credit (link to claude.ai billing), create a key in the linked
  Console org (link), paste it + a name.
- Auto-switch label: "Switch to the next account when one hits its limit — an
  API key only while every plan account is limited".
- Picking a metered account while auto-switch is on notes that new agents go
  back to a plan account with room.

## Out of scope (follow-ups)

- An estimated "≈ $X of $200 this cycle" meter (cost of conversations whose
  `conversations_ext_sdk_agent.account` is the key; there is no API for the
  promotional balance).
- Recognising "credit balance too low" as its own stop kind (marks the key
  exhausted until the next cycle).

## Files

- `plugins/infra/plugins/claude-cli/plugins/accounts/{core/internal/accounts.ts,
  server/internal/tokens.ts, machine/internal/{store,routes}.ts, guard/index.ts, CLAUDE.md}`
- `plugins/conversations/plugins/runtime-sdk/{core/usage-limits.ts(+test),
  bin/agent.ts, machine/internal/{agent-process,usage-probe}.ts,
  web/components/claude-accounts.tsx}`

## Verification

- `./equin test plugins/conversations/plugins/runtime-sdk plugins/infra/plugins/claude-cli`
  (launch/overflow cases, credential kind/env).
- `./equin check`, `./equin build`; the health report's Claude Code row shows
  both add entries; adding an `sk-ant-api…` key shows an "API key" row.
- Live: with a key from the linked org, an agent launched on it logs
  `auth ANTHROPIC_API_KEY` (agent.log `● session … · auth …`) and the Console's
  promotional credit decreases.
