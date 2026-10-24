# Site analytics: IP-to-country lookup

## Context

Deployed-site analytics (`plugins/apps/plugins/deploy/plugins/analytics/plugins/collect`, design in
[`2026-09-16-deploy-site-analytics.md`](./2026-09-16-deploy-site-analytics.md)) keeps a `country`
column on `analytics_visits`, but `openVisit` always writes `null`. So the dashboard's Countries
panel says "not collected yet", and "What one visit records" marks country the same way.

Goal: when a visit opens, the deployed server looks up the visitor's country in a local
IP-to-country table held in memory. The IP is used only for that lookup and the daily hash, then
dropped. It is never stored, and never sent to any outside service.

Decisions made with the user:
- **Data set: DB-IP IP-to-Country Lite.** License CC BY 4.0, so the dashboard credits DB-IP.
- **Delivery: the server downloads it.** A background job fetches the file when it is missing
  (right after boot) and refreshes it weekly. Visits in the short window before the first
  download finishes get no country.

## Facts the design rests on

- **The file.** `https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.csv.gz`. It needs no
  account and no key, and weighs about 4.5 MB gzipped. It holds IPv4 and IPv6 in one CSV
  (`start,end,CC`), about 717k rows. The ranges cover the whole address space. Private and
  reserved ranges are `ZZ`. A new file appears each month, so early in a month only the previous
  month's file may exist yet. Checked today: both `2026-09` and `2026-08` return 200.
- **Nothing is sent about the visitor.** The download is a plain GET for a public file. The
  lookup is a binary search in this process's memory.
- **The client IP already reaches collect.** `routes.ts` passes `requestClientIp(req)` (host-only
  plugin) into `CollectContext.ip`. It is used only in `visitorHash`.
- **Jobs.** `defineJob` with `schedule: { cron, perWorktree: true }` is required, because a
  deployed release is never main (see the comment on `analyticsRollupJob` in `rollup.ts`). A job
  holding a worker slot for a network call with its own timeout is `hold: "seconds"`. To run the
  job once at boot, enqueue it from `onReady` (precedent: `debug/worktree-cleanup/server/index.ts`).
- **Data dirs.** Every directory under the data root is declared with `defineDataDir`. The
  `asset-mirror` plugin's `data-dirs/index.ts` is the template for a re-downloadable cache.
- **Download helper to copy.** `asset-mirror/server/internal/fetch-to-disk.ts` does fetch, then
  a temp file, then an atomic rename.
- **The "not collected yet" mechanism has one user.** `notCollectedYet` in `RECORDED_FIELDS`
  (core) drives `isNotCollectedYet` in `dashboard/web/internal/panels.ts` and the badge in
  `recorded-fields.tsx`. Country is the only field that sets it.

## Design

### New primitive: `plugins/apps/plugins/deploy/plugins/analytics/plugins/ip-country`

It is generic: it knows nothing about analytics. Any server plugin can ask "which country is
this IP in?". Collect is its first user.

**`data-dirs/index.ts`**: `ipCountryCache = defineDataDir({ kind: "cache", name: "ip-country",
owner: "apps/deploy/analytics/ip-country", reclaim: { kind: "safe" } })`. It is shared across the whole machine
(or the whole install on a deployed box). Deleting it only costs a re-download.

**`core/`** (safe for the browser, constants only):
- `IP_COUNTRY_SOURCE = { name: "DB-IP", url: "https://db-ip.com", license: "CC BY 4.0" }`. The
  dashboard renders the credit from this, so the credit and the data source sit in one file.

**`server/internal/parse-ip.ts`**: parses an address string into a family plus a number. IPv4
becomes a `number`. IPv6 becomes a `{hi, lo}` pair of `bigint`s, with `::` compression expanded.
An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) is turned back into IPv4. Anything that is not an
address gives a discriminated `invalid` result, never `null`.

**`server/internal/snapshot.ts`**: turns the CSV into a compact binary snapshot.
- `buildSnapshot(csvText)` returns bytes. It sorts nothing (DB-IP is already ordered), but it
  **asserts** that ranges are ascending and do not overlap, and throws with the row otherwise.
  The format:
  - a header (magic, format version, source month, row counts);
  - a country-code table (`ZZ` is kept as an entry, so it can be recognised);
  - IPv4: start and end arrays (`Uint32Array`) plus a code index;
  - IPv6: start and end as hi/lo pairs (`BigUint64Array`) plus a code index.
  The IPv4 part is about 3 MB and the IPv6 part about 11 MB.
- `loadSnapshot(bytes)` returns typed-array views over the bytes with no copying. A wrong magic
  or version throws.
- `lookupIn(snapshot, ip)` binary-searches the family's starts, then checks the end.

The CSV is parsed once per download, inside the job. A backend boot therefore reads one file into
typed arrays and never re-parses 717k text rows.

**`server/internal/lookup.ts`**: the in-memory holder.
- `lookupCountry(ip: string): IpCountryResult`, where the result is
  `{ kind: "found", country: "FR" } | { kind: "unlisted" } | { kind: "unavailable" }`.
  - `unlisted` covers `ZZ`, an address outside every range, and an invalid address.
  - `unavailable` means no snapshot is on disk yet. Callers must handle this case, so "we do not
    know yet" can never pass as "this IP has no country".
- The snapshot loads lazily, on the first lookup: a synchronous read of about 14 MB, once per
  process. A backend that never looks anything up (most local worktrees) never pays for it.
- `reloadIpCountry()` swaps in the newly written file. The job calls it in the same process right
  after the rename, with no file watcher and no polling. There is one backend per install.

**`server/internal/refresh.ts`**: the `ip-country.refresh` job.
- `defineJob({ hold: "seconds", dedup: "singleton", schedule: { cron: "40 3 * * 1", perWorktree: true } })`.
- If the snapshot on disk is less than 7 days old, the job returns without downloading. That
  keeps the download to at most one per machine per week, even though every local worktree has
  the cron.
- Otherwise it downloads this month's file with `AbortSignal.timeout(60_000)`. A 404 means that
  month is not published yet, so it tries the previous month. Any other failure throws, so the
  job fails visibly and retries.
- The download is gunzipped in memory (`Bun.gunzipSync`). It goes through `buildSnapshot`, is
  written to a temp file and renamed onto `ip-country.bin`, and then `reloadIpCountry()` runs.
- Parsing about 90 MB of CSV text takes a noticeable fraction of a second. The parser works in
  chunks and calls `yieldMacrotask()` (`packages/macrotask-yield`) between them, so HTTP requests
  still get served during a refresh.
- `onReady`: enqueue the job when the snapshot file is missing or stale. A fresh install gets its
  data within about a minute of booting.

**Server barrel exports**: `lookupCountry`, `IpCountryResult`, `ipCountryRefreshJob` (the plugin
registers it itself), and `IP_COUNTRY_SOURCE` via core.

### `collect` changes

- `collect.ts` `openVisit`: `country: countryOf(ctx.ip)` in place of `null`. The small
  `countryOf` helper maps `found` to the code and both other cases to `null`, which the report
  already shows as "(none)". The IP stays only in `CollectContext`, exactly as today.
  - Only a new visit does the lookup. A hit that joins a live visit keeps the visit's country, the
    same way device and entry page are set once.
  - `collect/package.json` gains no dependency. `apps/deploy/analytics/ip-country` enters the site's closure
    through the import, and it depends only on paths, jobs and macrotask-yield.
- `core/internal/recorded-fields.ts`: the country field's description becomes "Country of the
  visitor's network, looked up on the server in a local copy of DB-IP; the IP address itself is
  not kept". Remove `notCollectedYet` from the field **and** from the `RecordedField` type.
- `server/internal/tables.ts`: drop the "Always null for now" comment.
- `collect/CLAUDE.md`: a short "Country" note covering where the lookup happens, that the IP is
  never stored, and that `(none)` also counts visits from before the first download.

### `dashboard` changes

- Delete `isNotCollectedYet`, `DIMENSION_COLUMN` (`panels.ts`), their branch in
  `ranked-panel.tsx`, and the badge in `recorded-fields.tsx`. With nothing left using them, they
  would be dead code.
- Countries tab:
  - Show a country name next to the code, e.g. "France (FR)", using
    `new Intl.DisplayNames(undefined, { type: "region" })`. The filter chip reads the same way.
    The value stored and filtered on stays the code.
  - Add a `note`: "Looked up from the visitor's IP, which is not stored. IP geolocation by
    DB-IP (db-ip.com), CC BY 4.0", built from `IP_COUNTRY_SOURCE`.
  - A code with no display name falls back to the raw code.

### Tests

- `ip-country/server/internal/parse-ip.test.ts`: IPv4 and IPv6 forms (compressed, full,
  IPv4-mapped, zone id rejected), and invalid input.
- `snapshot.test.ts`: build from a small CSV fixture (both families, a `ZZ` row, range edges),
  then round-trip load and look up the first, last and middle address of a range, an address in a
  gap, and `ZZ` coming back as `unlisted`. Out-of-order or overlapping rows throw.
- `lookup.test.ts`: `unavailable` with no file, `found` after a snapshot is written, and
  `reloadIpCountry` picking up a replaced file (using a temp data dir).
- `collect/server/internal/analytics.db.test.ts`: the existing seed path, with a snapshot fixture
  in place, fills `country` on a new visit. No column anywhere holds the IP. The
  `storedColumnsAreRecorded` compile-time check already guarantees that no IP column exists.
- `dashboard/web/__tests__/dashboard-states.test.tsx`: update the "not collected yet"
  expectation. The Countries tab now shows its rows and the credit.

## Critical files

- New: `plugins/apps/plugins/deploy/plugins/analytics/plugins/ip-country/{core,server,data-dirs}/**`, `CLAUDE.md`, `package.json`
- `plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/server/internal/collect.ts`
- `…/collect/core/internal/recorded-fields.ts`, `…/collect/server/internal/tables.ts`, `…/collect/CLAUDE.md`
- `…/dashboard/web/internal/panels.ts`, `…/dashboard/web/components/{ranked-panel,recorded-fields}.tsx`, `…/dashboard/web/internal/format.ts`

## Verification

1. `./equin test plugins/apps/plugins/deploy/plugins/analytics/plugins/ip-country plugins/apps/plugins/deploy/plugins/analytics`.
2. `./equin build`. After boot, the refresh job runs and `~/.singularity/cache/ip-country/ip-country.bin`
   exists. Check the job row with `query_db`.
3. Real lookup through the actual proxy chain. The gateway *appends* to `X-Forwarded-For`, so a
   header sent to this worktree's gateway URL arrives as `<given>, 127.0.0.1`, which reads as a
   public visitor. POST a pageview to `/api/analytics/collect` with
   `X-Forwarded-For: 81.2.69.160` and a desktop user agent. Then `query_db`:
   `SELECT country FROM analytics_visits ORDER BY started_at DESC LIMIT 1` should return `GB`, and
   no table should contain the address.
4. Dashboard: `screenshot.ts` on a deployment page shows the Countries tab with rows and the
   credit line. "What one visit records" shows no "not collected yet".
5. `./equin check`: boundaries, composition-closure (the website closure gains
   `apps/deploy/analytics/ip-country` and still has no `auth` or `agent-runtime`), data-dirs, migrations-in-sync
   (no schema change).
6. Deploy (only with the user's go-ahead): `deploy ship` the website. On the box, the refresh job
   downloads the file (outbound HTTPS; converge's firewall restricts only inbound). A real visit
   then shows its country in the local dashboard.

## Implementation note

The plugin first landed at `plugins/infra/plugins/ip-country`. `plugins/infra/CLAUDE.md` forbids
new top-level infra plugins without approval, so at review it moved under the analytics umbrella
(its only user). Its API stays analytics-agnostic.
