import { Icon } from "@plugins/ui/plugins/icons/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ComponentType, ReactNode } from "react";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { type SpaceStep } from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { railClass } from "@plugins/primitives/plugins/css/plugins/rail/core";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { SectionCard } from "@plugins/primitives/plugins/section-card/web";
import {
  defineRenderSlot,
  type RenderSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

/**
 * Pane-level options, declared ONCE by the slot owner in
 * `defineDetailSections(...)` — never by a section, so a pane's sections cannot
 * drift apart. Two closed choices:
 *
 * - **`chrome`** — which of `SectionCard`'s two chromes every section wears:
 *   `"card"` (default; a bordered card per section, leading chevron) or
 *   `"inspector"` (flat sections divided by a rule, chevron-free headers whose
 *   collapsed title is muted). The primitive paints both, so a pane picks a
 *   look without ever painting chrome of its own.
 * - **`inset`** — card chrome only: where the pane's content edge already is.
 *   An inspector stack has no inset by construction (its rules and hover fills
 *   run edge to edge), so the field does not exist on that arm.
 */
export type DetailSectionsOptions =
  | {
      chrome?: "card";
      /**
       * Horizontal/vertical inset around the section stack. Default `"lg"`.
       *
       * `"none"` is for a pane that ALREADY positions its content and would
       * otherwise inset it twice — Pages puts the page title, icon, and section
       * list at the shared block inset, so the stack must not add its own on
       * top. Either way each card body opens its own rail region (see
       * `CardSection`), so a DataView dropped into a section is inset once, by
       * the card.
       */
      inset?: SpaceStep;
    }
  | { chrome: "inspector"; inset?: never };

/** The fields every section carries, whatever its shape. */
interface DetailSectionCommon<EntityProps> {
  /** The section's title, and its click target: clicking it toggles the body. */
  label: string;
  /** Leading icon in the header row. Raw component; the row owns size + color. */
  icon?: IconRef;
  /** Header-right controls, reachable while collapsed. Rendered at `sm` density. */
  actions?: ComponentType<EntityProps>;
  /** Collapsed-state preview beside the title (a count, a +/− diff stat). */
  summary?: ComponentType<EntityProps>;
  /**
   * Gate hook. `false` ⇒ nothing painted at all — no card, no title.
   *
   * This is how a section that has NOTHING TO SHOW disappears: a body that
   * `return null`s still leaves a titled bar the user can open onto emptiness,
   * because the host paints the chrome and cannot see through the body to know
   * it rendered nothing. Emptiness must therefore be DECLARED here, where the
   * host can act on it before painting.
   */
  useAvailable?: Hook<(props: EntityProps) => boolean>;
}

/** A section with a body: a collapsible card, chevron and all. */
interface DetailSectionWithBody<
  EntityProps,
> extends DetailSectionCommon<EntityProps> {
  /** The body. Receives the pane's entity props. */
  component: ComponentType<EntityProps>;
  /** First-render open state when the user has no persisted choice yet. */
  useDefaultOpen?: Hook<(props: EntityProps) => boolean>;
}

/**
 * A section that IS one line: a value, a chip row, a single control. It declares
 * no `component`, so the host paints one static row — no chevron, nothing to
 * expand — with the line itself in `summary` (info) and/or `actions` (control),
 * beside the title.
 *
 * At least one of the two is REQUIRED: a one-line section with neither would be
 * a bare title over nothing, which is precisely the empty card this shape
 * exists to remove. `useDefaultOpen` is absent for the same structural reason —
 * there is no body for it to describe.
 */
type DetailSectionOneLine<EntityProps> = DetailSectionCommon<EntityProps> & {
  component?: never;
  useDefaultOpen?: never;
} & (
    | { actions: ComponentType<EntityProps> }
    | { summary: ComponentType<EntityProps> }
  );

/**
 * One section of a detail pane. The contribution supplies identity and content;
 * the HOST owns the chrome, so a pane's sections are uniform by construction —
 * a section never paints its own card, title, or chevron.
 *
 * Two shapes, and the shape is what decides the chrome: declare a `component`
 * and you get a collapsible card; declare none and you get one static row. The
 * chevron is therefore never a choice — it exists exactly when a body does.
 */
export type DetailSection<EntityProps> =
  DetailSectionWithBody<EntityProps> | DetailSectionOneLine<EntityProps>;

/**
 * `Extra` carries contribution fields the PANE defines and the primitive knows
 * nothing about — Sonata's `area: "editor" | "player"`, which routes a section
 * to one of its column's two zones. It widens only the contribution type; the
 * chrome, the slot id, and the persisted open-state key are untouched by it.
 */
export interface DetailSections<EntityProps, Extra extends object = {}> {
  Section: RenderSlot<DetailSection<EntityProps> & Extra>;
  Host: ComponentType<EntityProps>;
  /**
   * The stack the sections sit in — the rhythm between them and the inset
   * around them, per the pane's `chrome` (card: a small gap and the declared
   * inset; inspector: no gap, no inset — the rules divide it). `Host` paints its
   * one stack with it; a pane laying out several `SectionItem` zones wraps them
   * in it, so it never hand-sets a gap or padding the chrome already owns.
   */
  SectionStack: ComponentType<{ children: ReactNode }>;
  /**
   * The chrome for ONE contributed section — the same gate → card → persisted
   * open-state path `Host` applies per item, exposed for a pane that owns its
   * own zone layout and therefore cannot use `Host`'s single padded stack
   * (Sonata's rail-collapsible column splits its contributions across two
   * `.Render` zones by `area`).
   *
   * NOT an escape hatch from the chrome: it IS the chrome. A pane reaching for
   * it still cannot drift on padding, radius, title typography, or open-state
   * persistence — it only takes over where the sections are laid out. Reach for
   * `Host` unless the pane genuinely has more than one zone.
   */
  SectionItem: ComponentType<{
    section: DetailSection<EntityProps> & Extra & { id: string };
    entityProps: EntityProps;
  }>;
  /**
   * One section's persisted open state and its setter — the same device-local
   * value the card chrome reads (`<slotId>.<sectionId>.open`), for a pane that
   * opens a section from outside its card (a rail of section icons). A section
   * the user never touched reads closed here even when its `useDefaultOpen`
   * would seed it open: the seed belongs to the card.
   */
  useSectionOpen: Hook<
    (sectionId: string) => [boolean, (open: boolean) => void]
  >;
}

/**
 * A detail pane is ONE render slot whose sections are contributions.
 *
 * `defineDetailSections("<id>")` returns `{ Section, Host, SectionItem,
 * SectionStack }`: plugins contribute `DetailSection`s to `Section`, the pane
 * renders `<Host {...entityProps}/>`, and the host paints every section as a
 * `SectionCard` with a collapsible title row. The chrome is one CLOSED choice
 * the slot owner makes once (`chrome: "card" | "inspector"`, see
 * {@link DetailSectionsOptions}); there is NO per-section opt-out, so a pane's
 * sections cannot drift on padding, radius, title typography, or chevron
 * placement. A pane with more than one zone (Sonata's `area`-split column)
 * paints each section with `SectionItem` inside its own `SectionStack` — the
 * SAME chrome and rhythm, laid out by the pane.
 *
 * A pane's **identity block** (title input, primary actions) is a section like
 * any other, card and all: the entity's name lives in the pane header, so a
 * collapsed identity card loses nothing. An earlier `chrome: "none"` opt-out for
 * it was removed — it was indistinguishable from "this panel doesn't want your
 * card", which is how a self-painted card frame got back in.
 *
 * ## One line ⇒ no chevron
 *
 * A section whose whole content is one line — a path, a count, a chip row, a
 * single button — declares NO `component` and puts that line in `summary`
 * (info) and/or `actions` (control). The host then paints one static row: no
 * chevron, nothing to expand, nothing to persist. The affordance is derived
 * from the body's absence rather than declared, so "a chevron that opens onto
 * one line" and "a body with no way to open it" are both unrepresentable.
 *
 * ## Nothing to show ⇒ nothing painted
 *
 * A body that `return null`s still leaves a titled bar the user can open onto
 * emptiness: the host paints the chrome and cannot see through the body. A
 * section that can have nothing to show therefore declares `useAvailable`,
 * which is resolved BEFORE anything is painted.
 *
 * ## Open state
 *
 * Resolves persisted user toggle → `useDefaultOpen?.(props)` → `false`. The
 * persisted choice is device-local (`useDraft`, localStorage) under
 * `` `<slotId>.<sectionId>.open` ``, where `slotId` is this factory's own
 * `` `${id}.section` `` — so two panes' identically-named sections can never
 * collide.
 *
 * ## A collapsed body is genuinely UNMOUNTED
 *
 * `SectionCard`'s body is a `CollapsibleContent`, which renders `null` while
 * collapsed — a heavy panel costs nothing until opened. The corollary is a trap:
 * anything that must keep running regardless of the panel's state (debounced
 * persistence, a subscription that outlives the panel, a sync observer) does NOT
 * belong in the body. Lift it into a headless always-mounted contribution — a
 * `defineMountSlot` slot on the owning pane — and keep the body purely visual.
 *
 * ## Slot id (load-bearing)
 *
 * The emitted slot id is `` `${id}.section` `` verbatim, and
 * `reorderDirectiveDescriptor` uses a slot id verbatim as its config_v2 config
 * name. Renaming a slot silently resets every user's persisted section order on
 * that pane — never change the shape of this string.
 */
export function defineDetailSections<
  EntityProps extends Record<string, unknown>,
  Extra extends object = {},
>(options?: DetailSectionsOptions): DetailSections<EntityProps, Extra> {
  const Section = defineRenderSlot<DetailSection<EntityProps> & Extra>({
    // The human-readable title, not the id — this is what reorder's drag overlay
    // shows ("Tracks", not "track-mixer"). `label` is required on every section,
    // so it is always present.
    docLabel: (p) => p.label,
  });
  const chrome = options?.chrome ?? "card";
  const inset =
    options?.chrome === "inspector" ? "none" : (options?.inset ?? "lg");

  type SectionItem = DetailSection<EntityProps> & Extra & { id: string };

  /**
   * One section's persisted open state — the ONE spelling of its key, read by
   * the card chrome and by anything outside it that opens a section (a rail
   * that jumps to it). Read at RENDER, never at factory time: a slot's id is
   * derived from the plugin that declares it, so it does not exist while this
   * module evaluates. It still keys two panes' identically-named sections
   * apart.
   */
  function useSectionOpen(
    sectionId: string,
    defaultOpen: boolean,
  ): [boolean, (open: boolean) => void] {
    const [open, setOpen] = useDraft(
      `${Section.id}.${sectionId}.open`,
      defaultOpen,
    );
    return [open, setOpen];
  }

  interface SectionProps {
    section: SectionItem;
    entityProps: EntityProps;
  }

  /**
   * `summary` and `actions` share the header-right slot: both must stay visible
   * (and, for actions, clickable) while the card is collapsed, and
   * `SectionCard.title` takes a plain string — so this is the one node that can
   * sit beside the title. It is ALSO the whole content of a one-line section,
   * which is why the composition lives here rather than inside `CardSection`.
   */
  function headerRight(
    section: SectionItem,
    entityProps: EntityProps,
    open: boolean | undefined,
  ): ReactNode {
    const Actions = section.actions;
    const Summary = section.summary;
    if (!Summary && !Actions) return undefined;
    // The inspector says ONE thing beside a collapsible section's title: its
    // summary while it is shut (what you would see if you opened it), its
    // controls once it is open (the body shows the rest). Either falls back to
    // the other when a section declares only one.
    if (chrome === "inspector" && open !== undefined && Summary && Actions) {
      return open ? <Actions {...entityProps} /> : <Summary {...entityProps} />;
    }
    return (
      <Inline gap="xs">
        {Summary ? <Summary {...entityProps} /> : null}
        {Actions ? <Actions {...entityProps} /> : null}
      </Inline>
    );
  }

  /**
   * The card chrome. `defaultOpen` is only the seed for the persisted toggle —
   * `useDraft` resolves its initial value once, so a later flip of the
   * contribution's `useDefaultOpen` never yanks a card the user has touched.
   */
  function CardSection({
    section,
    entityProps,
    defaultOpen,
    Body,
  }: SectionProps & {
    defaultOpen: boolean;
    Body: ComponentType<EntityProps>;
  }): ReactNode {
    const [open, setOpen] = useSectionOpen(section.id, defaultOpen);
    const icon = section.icon;

    return (
      <SectionCard
        variant={chrome}
        title={section.label}
        icon={icon ? <Icon icon={icon} /> : undefined}
        actions={headerRight(section, entityProps, open)}
        open={open}
        onOpenChange={setOpen}
      >
        {/* No wrapper, and nothing to declare: `SectionCard`'s body opens its
            own rail region, so a DataView dropped into a section is inset once,
            by the card. The marker that used to live here spoke for a box in
            another plugin — which is why it had to be re-stated at every host
            that ever padded one. */}
        <Body {...entityProps} />
      </SectionCard>
    );
  }

  /**
   * A section with no `component`: the card IS one row. No `children` reaches
   * `SectionCard`, which is what drops the chevron and the open state — the
   * affordance is derived from the absence of a body, never declared.
   */
  function OneLineSection({ section, entityProps }: SectionProps): ReactNode {
    const icon = section.icon;
    return (
      <SectionCard
        variant={chrome}
        title={section.label}
        icon={icon ? <Icon icon={icon} /> : undefined}
        actions={headerRight(section, entityProps, undefined)}
      />
    );
  }

  /**
   * Resolves the contribution's `useDefaultOpen` hook. Its own component so the
   * hook is called unconditionally (see `AvailableSection` for why the split is
   * on presence, not on value).
   */
  function DefaultOpenSection({
    useDefaultOpen,
    section,
    entityProps,
    Body,
  }: SectionProps & {
    useDefaultOpen: Hook<(props: EntityProps) => boolean>;
    Body: ComponentType<EntityProps>;
  }): ReactNode {
    const defaultOpen = useDefaultOpen(entityProps);
    return (
      <CardSection
        section={section}
        entityProps={entityProps}
        defaultOpen={defaultOpen}
        Body={Body}
      />
    );
  }

  /**
   * Resolves the open-state seed, then hands off to the ONE chrome. The branch
   * is on the hook's *presence* (stable per contribution), so both leaves stay
   * rules-of-hooks clean — the same split `AvailableSection` makes.
   */
  function OpenStateSection({ section, entityProps }: SectionProps): ReactNode {
    const Body = section.component;
    // No body ⇒ one static row, and nothing below applies: `useDefaultOpen`
    // describes a body, and the contribution type forbids it without one.
    if (!Body) {
      return <OneLineSection section={section} entityProps={entityProps} />;
    }
    if (section.useDefaultOpen) {
      return (
        <DefaultOpenSection
          useDefaultOpen={section.useDefaultOpen}
          section={section}
          entityProps={entityProps}
          Body={Body}
        />
      );
    }
    return (
      <CardSection
        section={section}
        entityProps={entityProps}
        defaultOpen={false}
        Body={Body}
      />
    );
  }

  /**
   * Applies the contribution's `useAvailable` gate before anything is painted,
   * so an inapplicable section renders no card and no title rather than an empty
   * one. The hook's presence is stable per contribution, so branching on it up
   * in `SectionItemHost` keeps both leaves rules-of-hooks clean.
   */
  function AvailableSection({
    useAvailable,
    section,
    entityProps,
  }: SectionProps & {
    useAvailable: Hook<(props: EntityProps) => boolean>;
  }): ReactNode {
    return useAvailable(entityProps) ? (
      <OpenStateSection section={section} entityProps={entityProps} />
    ) : null;
  }

  function SectionItemHost({ section, entityProps }: SectionProps): ReactNode {
    if (section.useAvailable) {
      return (
        <AvailableSection
          useAvailable={section.useAvailable}
          section={section}
          entityProps={entityProps}
        />
      );
    }
    return <OpenStateSection section={section} entityProps={entityProps} />;
  }

  function SectionStack({ children }: { children: ReactNode }): ReactNode {
    return (
      // This stack OPENS the region: `railClass` pads and publishes the same
      // step in one declaration. It replaced `insetClass`, and swapping it back
      // is the mistake to avoid — `insetClass` pads WITHOUT publishing, so the
      // stack would inset its sections by a number none of them could read.
      // `{ rail }`, not `{ x }`: the both-axes member, the twin of the
      // `insetClass({ pad })` it replaces, so the block rhythm is byte-identical.
      //
      // The padding is still the pane's to decline. A pane that already
      // positions its content — Pages puts sections at the page's block inset —
      // passes `inset: "none"`, which opens the region at zero rather than
      // pushing the content in a second time. An inspector stack always opens
      // it at zero, with no gap: its sections are divided by their own rules.
      <Stack
        gap={chrome === "inspector" ? "none" : "sm"}
        className={railClass({ rail: inset })}
      >
        {children}
      </Stack>
    );
  }

  function Host(entityProps: EntityProps): ReactNode {
    return (
      <SectionStack>
        <Section.Render>
          {(item) => (
            <SectionItemHost section={item} entityProps={entityProps} />
          )}
        </Section.Render>
      </SectionStack>
    );
  }

  return {
    Section,
    Host,
    SectionItem: SectionItemHost,
    SectionStack,
    useSectionOpen: (sectionId: string) => useSectionOpen(sectionId, false),
  };
}
