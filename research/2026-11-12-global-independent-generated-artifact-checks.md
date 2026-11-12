# Independent oracles for generated artifacts; a missing icon glyph is loud

## Context

conv-1794354745-34vama: the icon manifest scan (`codegen/core/icon-manifest.scan.ts`)
missed `{ ...symbol("progress-activity") }`. `icons:manifest-in-sync` compared the
generated manifest to a fresh run of the SAME scan, so both sides were wrong
together and the check passed. At runtime `<Icon>` `<use>`d a symbol id absent
from the sprite and drew an empty box, reported nowhere. The scan itself was
fixed (91025caa32: TS syntax tree), but the class remains:

1. a check whose oracle is the generator cannot catch a generator bug;
2. a sprite that does not hold an asked-for symbol is silent at runtime;
3. other `*-in-sync` checks may share the self-verifying shape.

## 1. Independent cross-check: `icons:manifest-covers-uses`

The oracle is **ESLint's scope analysis** — the same resolution the
`icons/literal-icon-name` / `reserved-state-icon` lints already run — not the
generator's TS name-walk:

- New `icons/core/icon-calls.ts`: `iconConstructorCalls(program, filename, getDeclaredVariables)`
  → every `{ marker: "symbol"|"brand"|"seti", name, node }` literal call of a
  constructor imported from an icon-ref module (`isIconRefModule`), found by
  following the import specifier's declared variable to its references. Type-only
  import of `@typescript-eslint/utils` types (erased; `lint/` may import only `core`).
- `literal-icon-name` and `reserved-state-icon` read their calls through it, so
  "what lint sees" and "what the cross-check sees" are one function.
- `icons/check/icon-uses.scan.ts`: a `FileScan` that parses with
  `@typescript-eslint/parser` `parseForESLint` (its `scopeManager`) and returns
  the file's names via `iconConstructorCalls`. Cached per blob through
  `plugin-records`' `scanFilesCached` (same per-file record machinery as every
  scan; the scan module url keys it).
- File set chosen independently of the generator's barrel-free plugin walk:
  every tracked `plugins/**.{ts,tsx}` from `ctx.repo()`, minus `.d.ts`,
  `*.generated.ts`, tests (`*.test.ts(x)`, `__tests__/`, `/testing/`); cheap
  text prefilter `/\b(symbol|brand|seti)\b/`.
- The check reads the committed `ICON_MANIFEST` file (parse its literal lists
  from the file text — it is not importable from `check`'s row without loading a
  machine barrel), and fails listing every `name` used but absent, with file:line.
- `icons:manifest-in-sync` stays (drift), its description says it is drift-only.

Switch-over: when the parallel `checks/core` TS-program analysis API lands, only
`icon-uses.scan.ts`'s parse changes; `iconConstructorCalls` is the seam.

## 2. `<Icon>` asked for a glyph its sprite does not hold → report + visible marker

- `sprite-store.ts`: `spriteHolds(key, id)` — the held sprite's `<symbol id>`
  set, built once per provided markup (regex over our own generated markup;
  works in the static server render where `DOMParser` is absent).
- `icon-drawing.ts`: every sprite-sourced drawing (Material style sprite, brands,
  Seti, a sprite family such as Lucide) whose sprite IS held but lacks the id
  resolves to a new `DrawingSource` `{ kind: "missing", sprite, id, icon }`
  instead of a `<use>` of nothing. (Not held = loading, unchanged.)
- `<Icon>` draws a visible missing marker (crossed dashed square, inline) and
  reports once per (sprite, id) per page through a new
  `iconMissingGlyphReportSink` (`web/internal/missing-glyph.ts`, same
  `defineReportSink` inversion as `iconFamilyGapReportSink`).
  `useIconMarkup` returns the same marker markup and reports, replacing its
  bare throw — one resolver answer for both readers.
- New `plugins/reports/plugins/icon-missing-glyph` (mirror of
  `icon-family-gap`): core payload + fingerprint (sprite + id), server
  `ReportKind` (`variant: "error"`, task text points at the manifest scan /
  `icons:manifest-covers-uses`), web collector at `Core.Root` + Debug → Reports
  kind view.

## 3. Audit of other generated-artifact checks

See the table appended below (filled from the audit). Self-verifying checks
that gate a runtime resource are fixed here; the rest are filed as sidequests
(`add_task`, track sidequest, start manual).

## Verification

- `./equin test plugins/ui/plugins/icons plugins/reports/plugins/icon-missing-glyph`
  — unit tests: `iconConstructorCalls` (spread, argument, default, shadow-free),
  the scan on a fixture with `...symbol("x")`, `resolveIconDrawing` → `missing`
  when a held sprite lacks the id, jsdom `<Icon>` emits to the sink once.
- Negative proof: temporarily delete a name from the generated manifest →
  `./equin check icons:manifest-covers-uses` fails naming it; restore.
- `./equin build`, `./equin check`.

## Audit result (2026-11-12)

18 of the 31 generated-artifact checks compare the committed file to a re-run of
the generator that wrote it (`formatGenerated(render…(pass))` compared byte for
byte). The table lists the ones that gate a runtime resource. The runtime
consequences come from the audit's reading of the code; some were not traced to
the consumer.

| Check | Artifact | When the generator misses an entry | Action |
|---|---|---|---|
| `icons:manifest-in-sync` | icon manifest → sprites | Silent empty box | **Fixed here** (§1, §2) |
| `plugins-registry-in-sync` | plugin registries | The plugin never loads | task-1794457917-1t5f3x |
| `app-declarations-in-sync` | `declaredApps` | No manifest or theme scope, silent | task-1794457920-lt4ts5 |
| `theme-declarations-in-sync` | theme declarations | Tokens not emitted, silent | task-1794457922-316dqr |
| `app-css-utilities-in-sync` | twMerge custom utilities | `cn()` mis-merges, silent | task-1794457925-z1rdg7 |
| `space-ramp-in-sync` | ramp classes | Step has no class, silent | task-1794457928-p61rn9 |
| `reorderable-slots-in-sync`, `data-views-in-sync` | config registrations | No config (whether it throws is unverified) | task-1794457930-viw5f4 |
| `fields-eager-in-sync` | eager storage imports | Fails loudly, but far from the cause | task-1794457933-45mjse |

Self-verifying, but loud or dev-only, so no action: `server-core:backend-entry-in-sync`
(boot breaks), `eager-tier-in-sync` (fails toward the safe side), `migrations-in-sync`
(drizzle-kit is the oracle), `config-origins-in-sync` (also checked against its zod
schema), `color-token-ref-in-sync`, `exempt:rule-ids-in-sync`, the Seti names file,
`barrel-stubs-in-sync`, `plugins-doc-in-sync`.

Deviation from §1: only `literal-icon-name` and the two `reserved-*` rules
read through `iconUsesIn`, as planned. The check parses each file with
`@typescript-eslint/parser` and sets parent pointers itself, because the parser
leaves `parent` unset and ESLint only sets it while it traverses.
