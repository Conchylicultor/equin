# DataView default redesign + Sonata covers

## Context

Sonata's player and the Prototypes viewer were redesigned to feel modern and immersive. Their
gallery/list views did not follow: the DataView default card is a padded box with a generic icon,
one caption line per field (variable height), italic "Empty" for missing values, a hover-only "+"
for views and an opaque toolbar band. This is structural — every DataView looks like that.

Approved direction (prototypes proto-1792667077-4bakda, Sonata; proto-1792667078-9zh04x, Prototypes),
applied as **the new DataView default for every surface**, per-app looks through theme tokens only:

- One toolbar row: title · views pill (with an always-visible **+**) ··· tools pill (search,
  always expanded · filter · sort · settings | create). Both pills same height, aligned at every
  width (views scroll sideways, never wraps). Floating surfaces; content scrolls under with a fade.
- Gallery card, one size everywhere: cover (16/10) is the card; title · subtitle (visible text
  fields joined with ·) · one line of icon+value tokens (other visible fields). Fixed line heights.
  Missing values omitted, never "Empty". Fields follow the view's existing `properties` setting, in
  card and list alike.
- Actions: revealed ones on hover in a float chip at the cover's top-right; an action that is
  "on" (pinned, done) stays visible there at rest; a **primary** action (Sonata Play) is a round
  button bottom-right of the cover on hover, and over the list thumbnail on hover. List actions stay
  hover-only.
- List: the cover as a small leading thumbnail.
- Group headers: collapsible, label + count, hairline, chevron on the **right** (always visible, faint).
- Sonata covers drawn from the real song: MIDI = its real notes as falling notes; MusicXML = a staff
  of its real first bars; chord grid = its real chords as degree-coloured ChordBox tiles; Ultimate
  Guitar = the aligned YouTube recording's thumbnail + "Key X" badge.

## Design decisions

1. **Item actions** (`data-view/core/internal/types.ts`, `web/internal/{define-item-actions,use-item-action-zones}.tsx`):
   `ItemActionZone = "revealed" | "persistent" | "primary"`; contributions gain
   `useActive?: Hook<(row) => boolean>`; `ItemActionProps` gains `placement: "cluster" | "primary"`.
   Rule (one place): `persistent` rests unless it has `useActive` (then only while active);
   `revealed`/`primary` rest only while active. `useItemActionZones(desc, {hasPersistentSlot,
   hasPrimarySlot})` (both required) → `{cluster:{atRest,revealed}, primary:{…}|null}`. No primary slot
   ⇒ primary demotes to persistent (table keeps Play visible). Two `primary` contributions ⇒ throw.
   `RowActions` gains `chrome="float"`.
2. **Cover belongs to the surface**: `CoverContent` moves to data-view core; `DataViewProps.cover?:
   (row) => CoverContent | null`; `resolveCover` precedence: accessor → `FieldDef.cover` → first media
   field. Shared `<CoverFrame size="card" | "thumb">`; a coverless row in a covered surface gets a
   tinted blank frame (size stays constant).
3. **Card text partition** in one helper `web/internal/card-fields.ts` → `{title, indicators,
   subtitle (type text), tokens (rest)}`; token icon = new `FieldDef.icon` else the field type's icon.
   `<CardMeta>` draws three fixed lines (a line exists when the *view* has fields for it).
   `isFieldValueEmpty` extracted from `editable-cell.tsx`; card/list skip empties (table keeps the
   edit affordance).
4. **`DataCard` rebuilt** around the cover; old `media/leading/footer/size` props and gallery options
   `renderBody/leading/size/cover/coverField/showCreateCard/minCardWidth` removed (tsc flags callers).
   Grid sizing from tokens.
5. **Toolbar**: new `PillsToolbar` shared by `barArrangement` and `floating-toolbar`;
   `ControlSizeProvider size="sm"` makes both pills equal height; compact fold keeps the two pills.
   `Sticky` gains `mask: "fade"`. Switcher "+" always visible.
6. **Group header**: the new look replaces `"standard"` (`SectionHeaderRow variant="group"
   disclosure="end" rule`); `"quiet"` unchanged.
7. **Tokens** (existing groups): shape `radiusCover`, `radiusFloat`; density `galleryCardMin(Compact)`,
   `galleryGapX/Y`, `coverThumbW/H`, `stickyFadeTail`; shadow `shadow-cover(-hover)`. Sonata theme adds
   a `material` fragment (glass float fill/backdrop) + shape/density/shadow; Prototypes theme its values.
8. **Sonata covers** (new plugin `apps/sonata/plugins/covers`):
   - Roll/staff covers are server-rendered SVG (piano-roll palette is fixed data in `look/core`, not
     theme) — `renderRollCover(score)`, `renderStaffCover(score)` (pure, core), using
     `parseMidi`/`parseMusicXml`. Rendered on request, cached in a `cache` data-dir keyed by
     `sha256(contentHash|COVER_RENDER_VERSION)`, URL versioned by the row's `sourcesChangedAt`
     (immutable when current, `no-store` otherwise). No job, no polling.
   - Chord-grid tiles render client-side (`kind:"node"`) so they read the themable `--chord-N` tokens.
   - Open seam `Library.Cover` slot: each source answers `art | pending | failed | undefined`;
     resolver: failed > pending > art; two arts throw. Library never names a source. Generic fallback
     = quiet source-tinted cover (pending is a state, not a stand-in).
   - Exposed columns via `exposes` + `LiveColumns.Expose`: chord-grid `chordText`, UG `key`,
     UG-alignment `videoId`.

## Phases (file ownership; order T ∥ A → B ∥ C ∥ D ∥ S1 → E ∥ S2 ∥ S3 → G)

- **T — tokens/utilities**: `ui/plugins/tokens/plugins/{shape,density,shadow}/core/group.ts`,
  `primitives/css/ui-kit/web/theme/{app.css,surface.ts}`, `primitives/css/sticky`.
- **A — data-view contracts**: `data-view/core/internal/types.ts`, item-action zone files, new
  `web/internal/{cover,card-fields}.ts`, `web/components/{cover-frame,card-meta}.tsx`,
  `editable-cell.tsx`, cover pass-through (`data-view.tsx`, `data-view-body.tsx`, `body-types.ts`),
  mechanical hook updates in table/list/gallery views.
- **B — gallery + migrations**: gallery plugin (`data-card.tsx`, `gallery-view.tsx`, types, tests),
  `row-actions` `chrome="float"`; callers: theme-gallery (`renderBody` → cover node `ThemePreview`),
  places, events, sonata `song-library.tsx` (interim), prototypes gallery.
- **C — list**: list plugin only (thumbnail cover, primary over thumbnail, skip empties).
- **D — toolbar/switcher/groups**: `toolbar/{bar-arrangement,data-view-toolbar,pills-toolbar}.tsx`,
  floating-toolbar, `editable-view-switcher.tsx`, `group-header.tsx`, `section-header-row.tsx` (+ tests).
- **E — Prototypes app**: gallery (pin/done `useActive`, `views gallery+list`, visible `modifiedAt`,
  `versions` field, problems as indicator), files (`prototypes.versionCounts` live value from
  `_history/*/latest.json`, notified by the existing watcher), canvas exports `CanvasGround`,
  `pane-chrome.tsx` `ground` prop, gallery config (+ "Recently edited" list view), theme values.
- **S1 — Sonata covers core** (`apps/sonata/plugins/covers`): window, roll + staff renderers,
  `serveScoreCover`, data-dir, tests.
- **S2 — Sonata library adoption**: `Library.Cover` slot + resolver + `<SongCover>`; Play →
  `zone:"primary"` with `useActive` = playing; field icons; `views gallery+list+table`; saved views
  config (Cards gallery; All/Longest list; Composed; add Recent); Sonata theme fragments.
- **S3 — per-source covers** (one agent per plugin, disjoint): MIDI route + contribution; MusicXML
  route + transcription pending/failed; chord-grid expose + `ChordGridCover`; UG `key` expose +
  alignment `videoId` expose + YouTube cover (contributed by alignment, avoids a cycle).
- **G — exhibits + docs**: data-view exhibits (`gallery-card`, `list`, `toolbar`, `group-headers`)
  with committed config; CLAUDE.md updates (data-view, gallery, list, row-actions, sticky, surface,
  tokens, sonata library/covers).

Not in this pass: rewriting song titles in the DB (underscores, YouTube URL suffix) — it mutates
user data; proposed as a follow-up.

## Risks

Every DataView toolbar and card changes (embedded views, narrow panes, compact fold); pinned
group headers under a fading band; `useActive` cost per card (measure); `@hash` config files
re-hashed by build; the Prototypes pane title row above the toolbar (fold the title into the
toolbar).

## Verification

1. `./singularity check`; `./singularity test` on data-view, row-actions, sticky, row,
   theme-gallery, prototypes, sonata library/covers/sources.
2. `./singularity build`; `exhibit-shot.ts --id data-view/{gallery-card,list,toolbar,group-headers}`
   under `--theme prototypes|sonata|chrome`.
3. `screenshot.ts --path /prototypes` and the Sonata library route at 1440×900 and 700×900; hover
   checks with `browser_*` (cover actions, primary button, list thumbnail); a new
   `sonata/library/e2e/covers.ts` (every cover loads, `immutable`, chord-grid edit updates tiles).
4. `data-view/e2e/live-pages-scroll.ts --view gallery`; spot-check other DataView surfaces
   (agent manager lists, settings, debug tables, places, theme gallery).
