# chrome-theme

The app chrome's theme: a **fixed theme** (see `ui/theme-engine`) named
`chrome`, in a neutral graphite. Every chrome surface wears it with
`<Theme name={chromeThemeScope} …>` — the rail, the tab bar (and the docked
action bar inside it), the floating action bar and the toaster — and so does
every popover opened from them.

Why fixed, not the focused app's theme: the chrome frames apps that each have
their own look. Following the focused app made the frame change colour on every
app switch; a constant neutral frame lets a light app and a dark app both look
at home inside it, and keeps the only accent on screen the app's own.

It names colours (`color-palette`, `sidebar-palette`), the chrome's two
heights (a 36px bar, 26px controls), its control labels (`type-scale`'s
control role: 12.5px, regular — tab titles and button labels alike) and
`antialiased` font smoothing (`font-family`), which draws light text on the
graphite at the font's own weight. The font, the rest of the type scale, radii
and spacing are the defaults, so the chrome is set in the same face as the
apps. `scheme: "dark"` — the frame does not flip with the light/dark switch.

**Lucide icons.** The chrome's `icons` fragment sets `iconFamily: "lucide"`,
so every `symbol("…")` drawn in the chrome scope — the rail's app marks, the
tab bar, the docked and floating action bar, and every popover opened from
them — draws its Lucide counterpart (`LUCIDE_MAP`, `ui/icons`): thin, even
strokes that sit quietly on the graphite. The icons token bridge publishes the
fixed scope's style to the icons primitive, so nothing in the chrome names a
family. A symbol mapped `material-only` keeps its Material drawing (outline,
filled when active). Apps outside the chrome keep their own theme's family.

**Bar metrics.** A Lucide glyph fills 7/8 of its box, so the chrome's `md`
control (the floating action bar's 32px buttons, a chrome popover's actions)
draws an 18px icon box (`controlIconMd`) — a 16px glyph — with a 7px label
gap (`controlGapMd`). A pill's rounded ends add 2px (`shape`'s
`pillPadExtra`), so a split pill's outer end sits 12px from its icon and its
joined end 10px. Count chips (the bell's badge) are `tag-compact` at 9.5px on
a 16px line, `fontWeightTagStrong` 650. The `2xl` shadow tier is the
chrome's floating shadow (`0 10px 30px -8px` at 60% black + `0 2px 6px` at
35%), worn by the floating bar's glass capsule and, as `shadow-popover`, by
every popover opened from the chrome.

**Popovers are the bar's material.** A popover, menu or tooltip opened from
the chrome wears the bar's ground (`popover` = the ground, opaque), the bar's
ring (`popoverBorder`: the text at 9%), its hover (`popoverHover`: the text at
8% — a tint, not an opaque step), the floating shadow and 14px corners
(`radiusPopover`), so it reads as more of the bar rather than as a lighter
second surface. `card` stays the one-step-lighter panel tone. The app
launcher's grid is chrome too, from every app: its button sits in the app's
header, so it opens through `<PopupTheme name={chromeThemeScope}>`
(`theme-boundary`) — the popup wears the chrome, the button keeps the app's
theme. Designed in the "Chrome popovers" prototype
(`proto-1791550209-ma722m`, its `solid` surface).

Its one accent is the signal blue (the build spinner, the focus ring): it is also the
chrome's `primary`, so a primary action in a chrome popover (Improve's
Create task) lights in it. A text
field in a chrome popover is a well (`composer`: 22% black over the panel), a
shade darker than the panel around it.

**Deep solid fills.** The few small status controls that wear a saturated
fill at rest use `color-palette`'s solid role, not `info` / `destructive` /
`warning`: `infoSolid` is a deep navy (`#113b7b`), `destructiveSolid` an
oxblood (`#72151b`) and `warningSolid` a deep amber (`oklch(0.45 0.10 65)`,
≈`#7a4702`), all with white text (≈10.6:1, ≈11.4:1 and ≈7.6:1). They paint
exactly four things: the Reload pill (`build`: navy when the tab is only
stale, oxblood when something already fails), the bell's badge
(`shell/notifications`: oxblood with an unread error, amber with only
warnings), a failed build's dot and the 45% hairline round its tray, and the
activity ring's broken stroke.

`info` / `destructive` / `warning` stay bright (the signal blue, the alert
red, the warning amber) because about twenty chrome surfaces use them as
TEXT, icon, border or stroke on the graphite panel — the notifications panel's severity lines, the build popover's
errors, Improve's "Experimental" label, the gear popover's danger rows, the
crash chip, `Button variant="destructive"`, `Badge` tones. At the solid fills'
depth (≈1.5:1 against the bar) every one of them would go unreadable, so the
fill is its own token rather than a repaint of the shared one. Against the bar
the solid fills read through their light text, not their shape — which is why
the badge keeps a 2px ring in the surface's ground (`ring-chrome-mask`) to cut
it out of the bell. Outside the chrome the solid tokens default to the status
colours themselves, so no other theme changes.

Designed from the "App chrome" prototype (`proto-1789460441-wknb`: banner
layout, graphite tone, underline tabs).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The app chrome's fixed theme (graphite): the rail, tab bar, action bar and toasts wear it whichever app is focused, so the frame stays the same while the app inside changes.
- Web:
  - Contributes: `ThemeEngine.FixedTheme` "Chrome"
  - Uses: `ui/theme-engine.ThemeEngine`
  - Exports (values):
    - `chromeTheme`
    - `chromeThemeScope`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --popover`
    - `ui/tokens/shadow --shadow`
    - `ui/tokens/shadow --shadow-2xl`
    - `ui/tokens/shadow --shadow-popover`
  - Imported by:
    - `apps-core/app-launcher`
    - `apps-core/app-rail`
    - `apps-core/tab-bar`
    - `plugin-meta/exhibits`
    - `shell/global-action-bar`
    - `shell/toast`

<!-- AUTOGENERATED:END -->
