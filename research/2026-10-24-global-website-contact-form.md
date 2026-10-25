# Website contact form: inline message form, box-side intake, approved deploy secrets

## Context

On the public site's landing page, the "Interested in supporting this vision?" card
(`apps/website/landing/contact`, `ContactSection`) has a "Get in touch" button that is a bare
`mailto:hello@equin.ai`. That opens the OS mail client, which most visitors don't use, so the
button leads nowhere. The agreed UI is prototype `proto-1788797350-gqju`, variant `contact: expand`:

- The address appears in the card's sentence.
- The card grows in place into a message form.
- When sent, the card shows a thank-you state.

The message has to reach us. Three facts shape the backend:

- **The deployed site is the `website` composition.** Its closure is seeded by `apps.website.**`. It runs its
  own server and embedded Postgres on the box, behind Caddy, and has no auth.
- **The analytics plugin is the template.** `apps/deploy/analytics` ingests publicly on the box
  (`collect`), keeps the box as the source of truth, and the local Deploy app reads it **over SSH**
  through a `hostOnly` route (`dashboard`).
- **The box holds no secrets today.** Converge writes only `SINGULARITY_LISTEN` into the 0600 env file and
  refuses `infra/secrets` in a deployed closure. `research/2026-07-29-global-composition-production-deployment.md`
  §Out of scope calls secret provisioning "required before any composition needing a credential can
  deploy". Sending email needs a credential (a Resend API key), so this plan builds that follow-up.

**Decisions (user, 2026-10-24):**

- The box stores each message and sends the notification email itself.
- The provider is **Resend**.
- Messages are surfaced as a **Deploy-page section read over SSH**.
- **No secret reaches the box without the user's explicit approval.** A new secret, or a changed value,
  blocks the deploy until the user approves it.

## Design

### 1. Deploy secrets with explicit approval (`apps/deploy/plugins/deploy-secrets`, new)

This piece is load-bearing, and it is generic: the contact form is only its first consumer.

- **Declaration (core, box-safe).** `defineDeploySecret({ key: "RESEND_API_KEY", description, owner })`
  is plain data. The plugin that needs the secret exports it from its `core/`. The deploy side discovers
  the declarations **in the composition's closure**, the same static closure `resolve-composition.ts`
  computes, through a facet over `core/` exports (a `deploySecrets` facet beside the existing plugin
  facets). It never names a contributor. This follows the collection-consumer rule: adding a second
  secret-needing plugin requires no edit to the deploy side.
- **Box read (server).** `readDeploySecret(decl)` reads `process.env[decl.key]` and returns a
  discriminated `{ kind: "set", value } | { kind: "unset" }`. It never returns `""`. On a dev worktree
  it answers `unset`, so consumers render or record "not configured" instead of failing silently.
- **Local value store.** The values live in the local secrets store (`infra/secrets`), under namespace
  `deploy-secrets` with the key as given. They are entered from the approval card. The deployed
  closure still never includes `infra/secrets`: only the local deployments server reads it.
- **Grants (local DB).** One row per deployment and key in `deploy_secret_grants`:
  - Columns: `deployment_id`, `key`, `value_fingerprint`, `approved_at`.
  - `value_fingerprint` is an HMAC of the value under a local key, so the table never holds the
    secret and a rotated value shows up as a different fingerprint.
- **Gate.** Before any leg is spawned, `run-deploy.ts` (`apps/deploy/deployments/server/internal`)
  compares two things:
  - The **required set**, from the closure's declarations together with the current local values.
  - The **granted set**.

  Every required key must have a value and an exact grant for that value's fingerprint. If not, the run
  ends with a new terminal outcome, `needs-approval`. It lists each item as `missing value`, `new`
  or `value changed`. Nothing is converged or shipped. If a key was granted but is no longer required,
  the run drops it from the env without approval, because removing a secret is always safe.
- **Delivery.** Converge receives the approved `KEY=value` lines over **stdin** of the SSH session,
  never in argv, and they are never echoed. It writes them into the existing 0600 `root:svc-<c>` env file
  next to `SINGULARITY_LISTEN`. The transcript redacts the values: the remote script prints keys only.
  Ship is unchanged, because systemd re-reads `EnvironmentFile` on restart. The `NO secrets` comment in
  `converge-script.ts` and the ADR's §Out of scope are both updated.
- **UI.** The deployment page gets a "Secrets" section, a DataView with one row per required key:
  - Columns: key, requesting plugin, description, status (`approved` / `new` / `value changed` /
    `missing value`).
  - Row actions: **Set value** and **Approve**. Approve is a deliberate per-row click; there is no
    approve-all.
  - A run refused with `needs-approval` links to this section, and the run outcome shows the same
    words through `runs/run-outcome`.

### 2. Message intake on the box (`apps/deploy/plugins/site-messages/plugins/intake`, new)

The split mirrors `analytics/collect` and `analytics/dashboard`, so a deployed closure stays free of the
deploy UI and of SSH. The website reaches this plugin by importing its core and web, exactly as it
already imports `analytics/collect`.

- **Table.** `site_messages` stores:
  - The visitor's input: `id`, `message`, `reply_to`.
  - Request context: `host`, `page`, `created_at`, `ip_hash`.
  - Classification: `verdict` (`accepted` | `spam`) with `spam_reason`.
  - Delivery: `notify_state` (`pending` | `sent` | `failed` | `not-configured` | `throttled`),
    `notify_error`, `notified_at`.

  It carries `ExcludeFromChangeFeed`, because public traffic writes it and nothing on the box renders it
  live.
- **Endpoint.** `POST /api/site-messages` (`defineEndpoint` in core) is wrapped in `capBodySize(8 KB)`.
  The body is strict zod:
  - `message`: 1–5000 characters after trim.
  - `replyTo`: a valid email, at most 254 characters.
  - `honeypot`: a string.
  - `elapsedMs`: a number.

  The response is a discriminated union: `{ kind: "sent" } | { kind: "rate-limited", retryAfterS }`.
- **Abuse protection, all server-side and cumulative:**
  - **Honeypot.** If the hidden `website` field is filled, or `elapsedMs < 3000`, the row is stored with
    `verdict: spam` and the endpoint still answers `sent`, so a bot learns nothing.
  - **Bot user agents.** `isBotUserAgent` is reused for the same `spam` verdict.
  - **Rate limit per visitor.** The limit is 3 per 10 minutes and 10 per day per `ip_hash`, where
    `ip_hash = sha256(install salt ‖ ip)`. The IP comes from `requestClientIp` and is never stored.
    Over the limit, the endpoint answers `rate-limited`, and the UI says so.
  - **Global email cap.** At most 30 notification emails per day. Messages past the cap are still
    stored, with `notify_state: throttled`. The next email that does go out notes "N more held — see
    the Deploy page".
  - **Retention.** A `retention` sweep deletes `spam` rows after 30 days. Accepted messages are kept.
- **Notification job.** Accepting a message enqueues `site-messages.notify`, a `defineJob` with retries
  and `perWorktree: true`, as the analytics jobs are. The job reads `readDeploySecret(RESEND_API_KEY)`:
  - If the key is `unset`, the job writes `not-configured`. It does not throw, because a dev worktree has
    no key by design.
  - If the key is `set`, it calls Resend:
    - `from`: `equin <noreply@equin.ai>`.
    - `to`: `CONTACT_EMAIL`.
    - `reply_to`: the visitor's address.
    - `subject`: "Website message from <replyTo>".
    - Body: plain text containing the message, the page and the time.
  - A send failure throws so the job retries. On final failure the job records `failed` with the
    provider's error.
- **Host-only list route.** `GET /api/host-only/site-messages?q=…` is wrapped in `hostOnly()`. It
  returns a bounded page, newest first, filterable by `verdict`.

### 3. Resend client (`integrations/plugins/resend`, new)

`sendEmail(apiKey, { from, to, replyTo, subject, text })` makes one `fetch` to
`https://api.resend.com/emails` and parses the response with zod. It returns
`{ ok: true, id } | { ok: false, status, error }`. The client is stateless and knows nothing about the
site, matching the style of `integrations/google-maps/places-api`.

### 4. Inbox on the Deploy page (`apps/deploy/plugins/site-messages/plugins/inbox`, new)

- **Shared SSH query.** First, extract the SSH plumbing of `analytics/dashboard/server/internal/{served,query-over-ssh}.ts`
  into a generic `hostOnlyQueryOverSsh(deploymentId, path, schema)`. That covers resolving the target,
  the semaphore, the curl argv and mapping SSH failures into a result. It moves into
  `apps/deploy/analytics/host-only`, renamed to fit, or a sibling `deploy/host-query`. Both analytics and
  the inbox consume it, so there is not a second copy.
- **Section.** A `DeploymentDetail.Section` "Messages" renders a DataView with these columns:
  - received
  - from (a `mailto:` reply link)
  - message (truncated; the row opens the full text)
  - verdict
  - notification state

  It loads on demand, like the analytics report. Its error arms are the same `no-ssh-key` /
  `ssh-failed` / `request-failed` vocabulary.
- The section shows only when the deployment's composition closure contains `site-messages/intake`.

### 5. The card (`apps/website/landing/contact`, edited)

These changes follow the `expand` variant.

- **Sentence.** The sentence ends "Write to [hello@equin.ai](mailto:)." with a copy icon that appears on
  hover. It reuses `primitives/copy-to-clipboard` (`CopyButton` / `useCopyToClipboard`). It is
  absolutely positioned, so it takes no layout space at rest.
- **Get in touch.** "Get in touch →" keeps its look, but it becomes a button that morphs the card into
  the form.
- **Form.**
  - Fields: a textarea ("What would you like to talk about?") and an email input ("Your email, so we can
    reply"), with Cancel and Send.
  - Send is enabled only when there is a message and a valid email. ⌘/Ctrl+Enter sends. Esc closes and
    returns focus to the trigger.
  - The hidden honeypot is visually hidden, `tabIndex=-1`, `autocomplete=off`. The form records its
    open time to send `elapsedMs`.
  - Send auto-pends, through the `Button` primitive.
- **Sent and rate-limited states.**
  - Sent shows "✓ Message sent — Thanks, we'll reply to <email>" with "Send another".
  - `rate-limited` shows an inline message. A network or server error shows an inline error that keeps
    the typed text. A message is never lost silently.
- **Morph.** A small `useHeightMorph(cardRef)` hook measures the card's height before and after the
  change and runs a top-anchored WAAPI height animation: 260 ms, with `overflow: hidden` only while it
  runs. It then scrolls just enough to bring Send into view. It lives in the contact plugin unless a
  primitive already does this; check `primitives/` for an existing collapse or measure animation first.
- **Docs.** The plugin's `CLAUDE.md` currently says "Do not add a form: there is no backend". It is
  rewritten to describe the form, and the description in `web/index.ts` is updated.

## Prerequisites (outside the code)

- Verify `equin.ai` in Resend by adding its SPF and DKIM DNS records, so that `noreply@equin.ai` can send.
- Create the API key. Enter it on the deployment's Secrets section, then approve it.

## Critical files

- **New plugins:**
  - `plugins/apps/plugins/deploy/plugins/deploy-secrets/{core,server,web}`
  - `plugins/apps/plugins/deploy/plugins/site-messages/plugins/{intake,inbox}`
  - `plugins/integrations/plugins/resend/server`
- **Deploy engine:**
  - `plugins/apps/plugins/deploy/plugins/deployments/server/internal/run-deploy.ts` (gate)
  - `plugins/framework/plugins/cli/plugins/deploy/cli/internal/converge-script.ts` (env lines from stdin)
  - `closure-guards.ts`, unchanged: `infra/secrets` stays refused
  - the run-outcome vocabulary (`needs-approval`)
- **Reuse and extract:**
  - `analytics/host-only` (`hostOnly`, `requestClientIp`)
  - `capBodySize` and `isBotUserAgent`, to be moved out of `analytics/collect` internals into
    `host-only` so both can import them
  - `analytics/dashboard` SSH querying, which becomes the generic helper
- **UI:** `plugins/apps/plugins/website/plugins/landing/plugins/contact/web/components/contact-section.tsx`
  and `plugins/apps/plugins/website/plugins/shell/core/site.ts` (`CONTACT_EMAIL`, reused).

## Verification

- **Unit tests** (`./equin test <plugin>`):
  - the intake classifier (honeypot, elapsed time, user agent)
  - the rate limiter windows
  - the spam retention sweep
  - the endpoint's zod limits
  - the gate's diff of required against granted (`new`, `value changed`, `missing value`, dropped)
  - the converge script's env rendering, asserting that values never appear in argv or in the echoed
    transcript
  - Resend response parsing
- **DB test** (`db-test-fixture`): accepting a message enqueues the notify job, and without a key the
  job ends in `not-configured`.
- **Local UI:** `./equin build`, then drive the website in my worktree with `browser_*`:
  - open the form
  - check the morph and the scroll to Send
  - send, see the sent state and "Send another"
  - copy the address
  - trigger the rate-limited state
  - take screenshots

  Check that `query_db` shows the row in `site_messages` with `notify_state = not-configured`.
- **Gate:** run a local-serve or test deployment. It must stop at `needs-approval` until the key is set
  and approved, and stop again after the value is rotated.
- **End to end on equin.ai,** with the user, after review and push: approve the key, deploy, send a real
  message, receive the email, reply, and see the message in the Deploy page's Messages section.

## Follow-ups (not in this plan)

- Extend the approval gate beyond secrets, for example to new plugins entering a deployed closure, if
  "something new deployed" should also require sign-off.
- Add Cloudflare Turnstile if the honeypot and rate limits prove insufficient. It would be a second
  approved deploy secret.
