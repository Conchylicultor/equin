# Errors in the website's live demo are reported to the website's own server

Task: att-1794360225. Follows `research/2026-11-10-global-plugin-scope-hosts.md`
(root mounts declare `scope: "page" | "each"`).

## Context

On the standalone website the demo's plugins are held **on demand**
(`webScopedEntries`). The page root's reader leaves them out (`excludingReader`),
so their `scope: "page"` root hosts never mount anywhere on the site. Today they
run only on main's `/demo`. The ones that matter:

- **The error collectors** (`reports/crash`, `endpoint-errors`, `resource-errors`,
  `optimistic-*`, `theme-resolution`, `icon-family-gap`, `main-thread-stall`, …).
  On the site, an error a visitor hits in the demo is lost.
- **Even with a collector, nothing would receive it.** `report()` posts to
  `POST /api/reports` through `pageTransport`, the declared page-telemetry path
  that `no-leak.ts` already sanctions. But on the site:
  - that route is the reports **engine's**, and the engine is not in the website
    bundle. It needs the desktop change producer, and its fix ledger reaches
    `infra.git.git-watcher`, which is `agent-runtime`, which the website
    `excludes`.
  - the route is owner-only, so an anonymous visitor would get a 403 anyway.

**User decision (2026-11-11):** the demo's errors must be reported to the
website's own server, and that public endpoint must be bounded by construction.

## Design

### 1. The collectors are page chrome, so the site holds them as page plugins

The collectors listen page-globally: `window` `error` / `unhandledrejection`,
and module sinks (`boundaryReportSink`, `endpointErrorSink`,
`resourceErrorReportSink`, …). Mounted once at the page root, they already
catch errors raised inside the demo subtree:

- `endpointErrorSink` fires for scope calls, because a browser server's
  transport inherits `telemetry: true` from the page.
- `report()` always goes to the page's server.

Making them `"each"` would mount them twice on main (page + scope) and double
every window listener. So they stay `"page"`, and the **website composition holds
them**: `extends: ["served-baseline", "reporters"]`, plus `reports.crash`.
`reports.crash` is in `self-improvement`, not `reporters`, so it is named
explicitly. Their server halves are portable `ReportKind` contributions (they
need `reports/server` only, never the engine). The `excludes` check proves that
at build. Any reporter whose closure reaches excluded infra is named
individually instead.

### 2. Where the site's reports go: a report channel installed per composition

- **`reports/web`** gains `reportChannel`, a `defineRequestSink`
  (`primitives/report-sink`): one handler, and its answer is returned. It was
  first sketched as a `defineInstallSink`, but that primitive guards render
  reads, and `report()` is never called during render.
  - `report()` stamps the body as today, then sends through the installed
    channel.
  - With no channel installed, it sends exactly as today (`submitReport` over
    `pageTransport`), so main is unchanged.
  - `report()`'s result becomes `ReportResult | { outcome: "batched" } |
    { outcome: "dropped" } | null`, because a batched report has no row id yet
    (`dropped`: over the channel's per-visit caps). The callers that read `reportId`
    (the crash boundary → launch-fix) already branch on `outcome === "recorded"`.
- **New plugin `apps/deploy/plugins/site-reports`.** It is a sibling of
  `analytics` and `site-messages`, the other things that ship inside a deployed
  site.
  - **`core/`** holds the contracts:
    - `siteReportsEndpoint`: `POST /api/site-reports`,
      `access: { public: "…bounded by body cap, per-visitor and global budgets,
      aggregated per fingerprint" }`.
    - Its strict batch body schema.
    - The host-only read `GET /api/host-only/site-reports`, for the deploy
      dashboard, like `analytics/query`.
  - **`server/`** holds the intake (§3).
  - **`plugins/channel/`** is web only. In the register phase it installs the
    bounded client channel (§4) into `reportChannel`.
    - It is listed in `base-exclusions` (`!apps.deploy.site-reports.channel.**`),
      the `crawlable.snapshot-render` precedent.
    - The website names it as an entry, so only the site (and any composition
      that opts in) sends there.
    - Main keeps the engine path.
- **`no-leak.ts`'s `SANCTIONED` list** gains `/api/site-reports`.
  - It is the one route the site's demo may reach on the page's server, besides
    the existing telemetry.
  - The demo itself never calls it: the page's collectors do.

### 3. Server intake: bounded at every layer, by construction

`site-reports/server/internal/`:

1. **Body cap.** `capBodySize(16 KB, implement(…))` from
   `analytics/host-only/server`, the same helper `collect` and `site-messages`
   use.
   - The batch is ≤ 20 entries.
   - Each entry is strict: `kind` must be a registered `ReportKind`, else 400.
     `source` must be one of `CLIENT_REPORT_SOURCES`.
   - `message` ≤ 1000 characters. `data` ≤ 2 KB serialized. `path` ≤ 512
     characters. `count` is 1–1000 (occurrences the client folded).
2. **Admission** (`admission.ts`, pure, in-memory, fixed windows, injected
   clock):
   - **Per visitor:** keyed by a salted hash of `requestClientIp(req)`, never the
     raw IP. The limit is N batches per minute. The map of tracked keys is capped
     (oldest window evicted), so memory is bounded.
   - **Global:** M batches per minute across all visitors.
   - Over either limit: 429 with `Retry-After`. Nothing is read past the gate,
     and the drop is **counted**.
3. **Fingerprint + fan-out.**
   - The intake runs each entry through the kind's `schema.parse` and
     `fingerprint`, the same identity the engine gives it.
   - It then admits the entry through the engine's cross-fingerprint gate,
     `createFanOutGate`. That gate is lifted from `engine/server/internal/fan-out.ts`
     into the portable `reports/server` barrel, and the engine imports it back.
   - The gate reads the same `reportsConfig` (`fanOutPerWindow`,
     `fanOutWindowMs`, `stormRosterMax`).
   - A collapsed fingerprint is counted as a drop (reason `fan-out`). No row is
     written for it.
4. **Aggregation.** An in-memory pending map holds fingerprint → `{kind, source,
   message, data sample, path, buildId, commit, count, first/last}`.
   - The map is bounded: ≤ the fan-out budget per kind per window, with a hard
     cap overall.
   - The map is flushed once per window by a one-shot timer, armed on the first
     entry. This is a debounce, not polling, and is the same shape as the
     fan-out storm timer.
   - The flush runs **one upsert per fingerprint** (`count = count + n`,
     `last_seen`), never one row per event.
5. **Storage cap.** `site_reports` (fingerprint PK) is capped at `MAX_ROWS`
   (2,000).
   - The row count is read at boot and kept in memory.
   - Past the cap, a new fingerprint is dropped and counted (reason `row-cap`).
     An existing fingerprint still counts up.
   - `defineRetention` deletes rows unseen for 30 days.
6. **Drops are counted, never queued.** `site_report_drops` holds one row per
   (window, reason) with `count`. It is upserted in the same flush, so it is
   bounded to windows × reasons, and also retained for 30 days.
7. **Duress.** Over budget the intake always drops. Nothing waits and there is no
   queue.

### 4. Browser channel: dedupe, cap, batch, back off

`site-reports/plugins/channel/web`, pure core `batcher.ts` with an injected
clock and send function:

- **Dedupe.**
  - The key is `hash53(kind, source, message, first stack frame)`
    (`packages/string-hash`).
  - The first occurrence is queued with its body. Later ones only increment its
    pending `count`.
  - A fingerprint already sent is never re-sent with its body: only its count
    rides the next batch.
- **Caps per visit** (one page load):
  - ≤ 20 distinct fingerprints. Beyond that, an entry is counted locally and
    dropped.
  - ≤ 10 POSTs.
- **Batch.**
  - Sent 5 s after the first queued entry.
  - Flushed on `pagehide` with `keepalive`.
- **Back off.**
  - On a network error, 429 or 5xx, the delay doubles: 5 s → 5 min. A 429's
    `Retry-After` is honoured.
  - After 5 consecutive failures the channel stops for the visit.
  - A 4xx other than 429 is final.
- **Anonymous, minimal body.**
  - No `clientId` and no `userAgent`.
  - The URL is reduced to its pathname, with no query or hash.
  - `message` is clamped. `data` string values are clamped to 300 characters,
    the whole of `data` to 2 KB.
  - `buildId` and `commit` are kept: they name the code, not the visitor.

### 5. The other page hosts: per-host decision

| Host | Decision |
|---|---|
| The `reporters` collectors + `reports/crash` | Held by the site as page plugins (§1). |
| `conversations/model-provider` `ModelCorruptionReporter` | Lacked, and that is fine. `conversations` is agent-runtime (excluded). Without it the sink falls back to `console.error`. The demo's stored models are its seed, which the demo e2e covers. |
| `apps-core/pane-morph` | Lacked. Expand in the demo falls back to plain navigation, its documented fallback. Whether the site should carry the morph for visual parity is filed as a follow-up task. |
| `apps-core/app-usage` | Lacked, legitimately. It records the owner's app usage. A visitor is analytics' job. |
| `config_v2/config-link` `ConflictWriteToast` | Lacked, unreachable. The demo's user layer is a fresh memory store over the committed layer, so it cannot be in conflict. |
| `shell/global-action-bar` `FloatingActionBarHost` | Lacked, legitimately. It is the equin shell's solo-mode chrome, and the site draws its own layout. |
| `infra/claude-cli` sign-in / availability | Lacked, legitimately. They are machine-only (agent-runtime). |
| `text-editor/paste-images` `DraftAttachmentHolds` | Should be `"each"`, because holds belong on the scope's server. On main's `/demo` it sends worker attachment holds to main today: a leak on main. It needs `DraftWrite` to carry the plugin scope, so it is **filed as a task**, out of this change. Until then it is lacked on the site, where the worker's orphan sweep reclaims demo uploads. |

Each "lacked" row is an **exemption declared by that plugin**: an
`exempt/index.ts` entry with `rule: "composition-closure:page-hosts-on-demand"`,
`kind: "sanctioned"` and the reason above. For the paste-images row it is
`kind: "debt"` with the filed task.

### 6. Build check: `composition-closure:page-hosts-on-demand`

The check is added beside `root-mounts-reached` in
`plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/`.

- For each non-main composition, resolve its bundle. Then compute
  `scopedOnlyWebPlugins(ctx, bundle)` (codegen `browser-host-scope.ts`, exported
  from the codegen core barrel). Those are the plugins the composition holds on
  demand.
- Read each one's root mounts from the static contributions facet (no barrel
  import): `Core.Root` entries and contributions to any `defineRootSlot` slot,
  with `scope: "page"`.
- Every such host that its plugin does not exempt is a failure. The message lists
  them **per composition**: `website: reports/crash (Core.Root CrashCollector)…`.
- `exemptable: true`. The runner fails an exemption that matches nothing, so once
  the site does hold a host, its stale exemption goes red.
- `./equin exempt list --rule composition-closure:page-hosts-on-demand` is the
  standing per-host list.

## Files

- `plugins/reports/web/report.ts`, `plugins/reports/web/index.ts`: the
  the `reportChannel` request sink and the `batched` / `dropped` arms.
- `plugins/reports/plugins/engine/server/internal/fan-out.ts` moves to
  `plugins/reports/server/internal/fan-out.ts` (exported). Engine imports are
  updated.
- New: `plugins/apps/plugins/deploy/plugins/site-reports/{core,server,plugins/channel/web}`,
  with tests and a CLAUDE.md.
- `plugins/plugin-meta/plugins/composition/core/config.ts`:
  - website `extends`/`entryPoints`;
  - the `base-exclusions` negative for the channel.
- `exempt/index.ts` in pane-morph, app-usage, config-link, global-action-bar,
  claude-cli sign-in / availability, model-provider and paste-images.
- New check:
  `checks/plugins/composition-closure/check/page-hosts-on-demand.ts`, registered
  in that folder's `index.ts`.
- `plugins/apps/plugins/demo/e2e/no-leak.ts`: `SANCTIONED`.
- New e2e: `site-reports/e2e/demo-error-reported.ts`.
- Docs: web-sdk CLAUDE.md, the *scope* bullet, pointing at the check.

## Verification

- **Unit (bun):**
  - `admission.test.ts`: per-visitor, global and eviction bounds.
  - The batcher: dedupe, caps, backoff and `Retry-After`.
  - The intake handler's schema rejections: unknown kind, oversize body.
- **Load test** (`site-reports/server/internal/load.db.test.ts`, `createTestDb` +
  `runMigrations`):
  - 2,000 simulated visitors (distinct `X-Forwarded-For`).
  - Half send the same error ×10, the rest a mix of 500 distinct errors, plus
    repeat offenders hammering from one IP.
  - Assert:
    - rows ≤ `MAX_ROWS` and ≤ the admitted fingerprints;
    - DB statements ≤ the admitted fingerprints + drop rows per window, measured
      by counting flush upserts;
    - the same-error count equals the sum of admitted occurrences;
    - per-IP and global 429s happen and the drop rows account for every
      rejected or collapsed entry;
    - the pending map and the admission map never exceed their caps.
- **Checks and build:**
  - `./equin check composition-closure:page-hosts-on-demand` fails with the list
    before the exemptions are written and passes after.
  - Then `./equin build`, and `./equin build --composition website`.
- **e2e:**
  - On the website build: `demo-error-reported.ts` (enter the demo, raise an
    error, read the host-only query), `live-demo.ts`, and `site-parity.ts --site
    --composition website`.
  - On my build: every `plugins/apps/plugins/demo/e2e/*.ts`, including
    `no-leak.ts` and `site-parity.ts`.
- **Review:** a review subagent (sonnet) on `git diff $(git merge-base HEAD
  main)`, then `./equin push`.
