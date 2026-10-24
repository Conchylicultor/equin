# Theme Customizer UX Improvements

## Context

The Theme Customizer pane at `/theme-customizer` is a flat, endlessly scrolling page (~3800px of content in a ~450px viewport). All 7 sections are always expanded, section headers are plain text that blends together, and the global preset picker looks identical to per-section presets. The app behind updates live as tokens change (so live preview is already handled), but navigating and focusing on a specific section is painful.

## Changes

### 1. Collapsible section cards in `defineDetailSections`

Add an optional `options` param to `defineDetailSections`. When `collapsible: true`, the Host wraps each section in a `Collapsible` with a card-style border, using `item.label` (already in every contribution but currently discarded) as the trigger.

**File:** `plugins/primitives/plugins/detail-sections/web/internal/define-detail-sections.tsx`

```tsx
export interface DetailSectionsOptions {
  collapsible?: boolean;
  defaultOpen?: boolean;
}

export function defineDetailSections<EntityProps extends Record<string, unknown>>(
  id: string,
  options?: DetailSectionsOptions,
): DetailSections<EntityProps> {
  // ... Section unchanged ...

  function Host(entityProps: EntityProps): ReactNode {
    if (options?.collapsible) {
      return (
        <div className="flex flex-col gap-2 px-4 pb-4">
          <Section.Render>
            {(item) => {
              const C = item.component;
              return (
                <Collapsible defaultOpen={options.defaultOpen ?? false}>
                  <div className="rounded-lg border border-border/60">
                    <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-sm font-semibold hover:bg-muted/30 rounded-lg">
                      <CollapsibleChevron className="size-3.5 text-muted-foreground" />
                      {item.label}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="px-4 pb-4">
                      <C {...entityProps} />
                    </CollapsibleContent>
                  </div>
                </Collapsible>
              );
            }}
          </Section.Render>
        </div>
      );
    }
    // Default: unchanged behavior
    return (
      <div className="flex flex-col gap-6 p-6">
        <Section.Render>
          {(item) => { const C = item.component; return <C {...entityProps} />; }}
        </Section.Render>
      </div>
    );
  }

  return { Section, Host };
}
```

Backward-compatible: the 4 other consumers (`PluginView`, `TaskDetail`, `Build`, `ForgeCatalogTables`) pass no options and get the existing behavior.

Imports: `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent`, `CollapsibleChevron` from `@plugins/primitives/plugins/collapsible/web`.

### 2. Opt in from ThemeCustomizer

**File:** `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/slots.ts`

```ts
export const ThemeCustomizer = defineDetailSections<{ search: string }>(
  "theme-customizer",
  { collapsible: true, defaultOpen: false },
);
```

### 3. Remove manual `<h3>` from all 7 section components

The Host now renders `item.label` as the collapsible trigger, so each section's `<h3>` is redundant. Remove from:

| File | Remove |
|------|--------|
| `plugins/ui/plugins/tokens/plugins/color-palette/web/components/color-palette-section.tsx` | `<h3 className="text-sm font-semibold">Color Palette</h3>` |
| `plugins/ui/plugins/tokens/plugins/chart/web/components/chart-section.tsx` | `<h3 className="text-sm font-semibold">Chart</h3>` |
| `plugins/ui/plugins/tokens/plugins/shadow/web/components/shadow-section.tsx` | `<h3 className="text-sm font-semibold">Shadow</h3>` |
| `plugins/ui/plugins/tokens/plugins/shape/web/components/shape-section.tsx` | `<h3 className="text-sm font-semibold">Shape</h3>` |
| `plugins/ui/plugins/tokens/plugins/typography/web/components/typography-section.tsx` | `<h3 className="text-sm font-semibold">Typography</h3>` |
| `plugins/ui/plugins/tokens/plugins/sidebar-palette/web/components/sidebar-palette-section.tsx` | `<h3 className="text-sm font-semibold">Sidebar Palette</h3>` |
| `plugins/ui/plugins/tokens/plugins/color-adjust/web/components/color-adjust-section.tsx` | `<h3 className="text-sm font-semibold">Color Adjust</h3>` |

Contribution labels already match h3 text exactly (verified via grep).

### 4. Collapse Color Palette & Sidebar Palette inner sub-groups by default

When a user opens the Color Palette section, they currently see all 19 tokens across 9 expanded sub-groups. Change inner `<Collapsible defaultOpen>` to `<Collapsible>` so sub-groups start collapsed too.

**Files:**
- `plugins/ui/plugins/tokens/plugins/color-palette/web/components/color-palette-section.tsx` — 9 inner group collapsibles
- `plugins/ui/plugins/tokens/plugins/sidebar-palette/web/components/sidebar-palette-section.tsx` — 4 inner group collapsibles

Keep Shape/Typography inner "Tokens" collapsible as `defaultOpen` since they only have 2-4 tokens each. Shadow's inner collapsibles are already intentionally configured (Parameters open, Preview closed).

### 5. Improve GlobalPresetPicker visual distinction

The global "Theme" picker and per-section preset pills are visually identical (`px-3 py-1 text-sm rounded-md border`). Make the global picker more prominent.

**File:** `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx`

Changes:
- Add a ruled eyebrow label ("Theme") using the `h-px bg-border` divider pattern
- Make preset buttons larger (`px-4 py-2.5`, `rounded-lg`, `border-2` for active)
- Add a preview swatch per preset (colored circle or mini palette showing the preset's primary color)

This creates clear visual hierarchy: large global presets at top, then compact per-section preset pills inside each collapsed section card.

## Not doing (intentionally)

- **Search auto-expand:** Mixing controlled (`open={true}` when searching) and uncontrolled (`open={undefined}` otherwise) on `Collapsible` would trigger React warnings about switching between controlled/uncontrolled. The current behavior (search filters within expanded sections) is acceptable. Can revisit with a dedicated `useAccordion` hook later.
- **Compact swatch grid for Color Palette:** The inner-group collapse (step 4) already solves the verbosity. A swatch grid is a larger visual redesign that can come separately.
- **Accordion mode (single-open-at-a-time):** No accordion primitive exists. Independent collapsibles are sufficient for 7 sections.

## Verification

1. `./equin build` and visit `http://<worktree>.localhost:9000/theme-customizer`
2. All 7 sections should be collapsed by default, showing only their label and chevron in a bordered card
3. Clicking a section header should expand it with chevron rotation
4. Inside Color Palette / Sidebar Palette, inner sub-groups should also start collapsed
5. Global preset picker should be visually distinct from per-section presets
6. Switching presets (both global and per-section) should still apply live
7. Token editing (color pickers, text inputs) should still work
8. Search should still filter within expanded sections
9. No duplicate headings (the old `<h3>` removed, new label in trigger)
10. Other `defineDetailSections` consumers (PluginView, TaskDetail, Build, ForgeCatalogTables) should be visually unchanged
