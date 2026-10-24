# Styling one instance of a primitive: the sub-theme is the API — make it findable and safe

## Context

Home's New app screen (`plugins/apps/plugins/home/plugins/new-app`, mock
`proto-1792811301-yksedx`) renders the standard `ComposerField`. The mock wants
that ONE field to have 16px corners, roomier text and bar padding, and the
`--surface` fill. The box's look comes only from tokens (`radiusCard`,
`padComposer`, `padComposerText`, `padComposerActions`, the palette's `composer`).
The task assumed the only sanctioned choices were retheming all of Home or an
ad-hoc `className`, and asked for a structural API that lets one instance or region take a different token set.

## Survey: the API already exists

| Mechanism | What it does | Fits "one instance"? |
|---|---|---|
| **Sub-theme** — `defineSubTheme` (`ui/theme-engine/core/sub-theme.ts`) + `ThemeEngine.SubTheme` contribution + `<Theme name={subThemeScope(x)} surface="none">` (`primitives/css/theme-boundary`) | A region wears a few token values on top of the surrounding theme. Tokens it leaves out are **inherited** from the app theme, not reset to defaults. Tokens derived from a named token are re-declared (`subThemeBlockValues`). Popups opened inside it leave it (region-only portal forward). Painted by the server in the first frame. | **Yes, exactly.** Already used per-instance by `prototypes/canvas` (`frameChipsTheme` on one stepper, `optionRowsTheme` on one popover's rows) and the website (gallery, closing, hero). |
| Fixed theme (`defineFixedTheme`, e.g. `hintsTheme`) | A whole theme, resolved over the defaults, that ignores the app's theme. | No: it would also drop Home's palette. |
| App theme (`homeTheme`) | Applies to the whole app scope. | No: it restyles every card and composer in Home. |
| Variant regions (`ui/variant-region`) | A chrome region with variants the user can switch per app (sidebar framing, tab bar…). | No: it is a user setting for a fixed set of chrome spots, not a way for an author to style one component. |
| `ComposerField` props | Behaviour only (rows, submit mode, bar slots). | Adding look props (`radius`, `padding`…) would create a second styling channel next to tokens. Rejected. |

So no new primitive is needed. The New-app agent did not find sub-themes for two
reasons, and those are what this plan fixes:

1. **Discoverability.** The only mention of sub-themes is one line in the
   `theme` skill, and it is framed around the website's pages. The places an agent
   actually lands do not point to it: the `no-adhoc-radius` / `no-adhoc-spacing`
   lint messages, and the docs for `text-editor` (ComposerField) and `css/card`.
2. **A silent no-op.** Using a sub-theme takes three steps: `defineSubTheme`,
   contribute it in the web barrel (`ThemeEngine.SubTheme(x)`), and wrap with
   `<Theme>`. If you skip the contribution, the region gets
   `data-theme-scope="sub:x"` but no style block exists, so nothing changes and nothing complains. This is the
   "you must also update X" coupling.

## Plan

### 1. Apply it to New app (the case that prompted this)

- New `plugins/apps/plugins/home/plugins/new-app/web/internal/theme.ts`:
  ```ts
  export const newAppPromptTheme = defineSubTheme({
    id: "home-new-app-prompt",
    label: "New app prompt",
    fragments: [
      shapeGroup.fragment(both({ radiusCard: "1rem" })),                 // .composer radius 16px
      densityGroup.fragment(both({
        padComposerText: "1.125rem 1.125rem 0.375rem",                   // textarea 18 18 6
        padComposerActions: "0.625rem 0.625rem 0.625rem 0.75rem",        // .comp-bar 10 10 10 12
      })),
      colorPaletteGroup.fragment(both({ composer: "var(--card)" })),     // --surface = Home's card (0.155)
    ],
  });
  ```
  `var(--card)` keeps following Home's palette in both modes.
- Contribute `ThemeEngine.SubTheme(newAppPromptTheme)` in `new-app/web/index.ts`.
- In `new-app-page.tsx`, wrap the `ComposerField` in
  `<Theme name={subThemeScope(newAppPromptTheme)} surface="none">`. The launch-option
  popovers opened from the bar leave the region, as intended.
- `./equin build` regenerates `theme-declarations.generated.ts` (server first paint).

### 2. Make a missing contribution impossible to miss (rung 3: a check)

Add the check `ui/theme-engine:sub-themes-contributed` in
`plugins/ui/plugins/theme-engine/check/index.ts`. For every exported
`const X = defineSubTheme(` in the repo, there must be a `ThemeEngine.SubTheme(X)` in
a web barrel of the same plugin or one of its ancestors. A plain scan is enough
(`git ls-files` + regex, the way other source-scanning checks do it). The failure
names the sub-theme and the barrel to add it to.

Rung 1 was considered: make the contribution derivable by having codegen collect
`defineSubTheme` declarations. That would change how
`theme-declarations-gen.ts` discovers declarations (today it reads the contributions) and add a second
discovery path for only one of the three declaration kinds. The check stops the bug
for much less churn. Recorded as a possible follow-up, not part of this plan.

### 3. Point agents at sub-themes where they get stuck

- **Lint messages** — append one sentence to `no-adhoc-radius`
  (`primitives/css/radius/lint/no-adhoc-radius.ts`) and `no-adhoc-spacing`
  (`primitives/css/spacing/lint/no-adhoc-spacing.ts`), and to the type-scale rule's message: *"To make one region or
  instance look different, wrap it in a sub-theme (`defineSubTheme` +
  `<Theme name={subThemeScope(…)}>`) that sets the token — see ui/theme-engine
  CLAUDE.md."*
- **`theme` skill** (`.claude/skills/theme/SKILL.md`): reword the sub-theme line
  around the general case ("one instance or region of a primitive — a hero
  prompt, a featured card — looks different from the rest of the app"), and
  list the four choices above in one line each: app theme / sub-theme / fixed theme / variant region.
- **`ui/theme-engine/CLAUDE.md`** "Sub-themes" section: add a per-instance
  example (the New-app prompt) next to the website one, and a line saying the
  contribution is required and enforced by the check.
- **Token-driven primitive docs** — `primitives/text-editor/CLAUDE.md`
  (ComposerField) and `primitives/css/card/CLAUDE.md`: one line each, *"Restyle one
  instance with a sub-theme over these tokens, never a className."*, listing the tokens
  that primitive reads.

## Files

- `plugins/apps/plugins/home/plugins/new-app/web/{internal/theme.ts, index.ts, components/new-app-page.tsx}`
- `plugins/ui/plugins/theme-engine/check/index.ts` (new) + its test
- `plugins/primitives/plugins/css/plugins/{radius,spacing}/lint/*.ts`, `plugins/ui/plugins/tokens/plugins/type-scale/lint/*`
- `.claude/skills/theme/SKILL.md`, `plugins/ui/plugins/theme-engine/CLAUDE.md`,
  `plugins/primitives/plugins/text-editor/CLAUDE.md`, `plugins/primitives/plugins/css/plugins/card/CLAUDE.md`

## Verification

- `./equin test plugins/ui/plugins/theme-engine`: the new check's test covers a
  sub-theme that is not contributed (fails) and one that is (passes).
- Temporarily remove the `ThemeEngine.SubTheme(newAppPromptTheme)` line, run
  `./equin check ui/theme-engine:sub-themes-contributed`, confirm it fails, then restore the line.
- `./equin build`, then
  `./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1792811301-yksedx`
  on the New app screen: the composer's diff region should shrink compared with before.
- With `browser_*` on `/home/new`, read the computed `border-radius` (16px) and
  `background-color` of the composer box. Then open another composer in Home (if
  there is one) or a launch-option popover and confirm it keeps the standard values.
