import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useMemo } from "react";
import {
  FloatingAction,
  FloatingActionFadeIn,
} from "@plugins/primitives/plugins/overlay/plugins/floating-action/web";
import { AdaptiveBar } from "@plugins/primitives/plugins/adaptive-bar/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import {
  useRecordUsage,
  useUsageOrder,
} from "@plugins/primitives/plugins/usage-rank/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

import { TemplateChip, type TemplateChipItem } from "./template-chip";
import { TemplatePanel, type TemplateListEdit } from "./template-panel";

const editIcon = symbol("edit");

export interface TemplateChipBarProps {
  /** Every template, in the authored (config) order — the never-used tie-break. */
  templates: readonly TemplateChipItem[];
  /** How many of the most-used templates stay out as chips; the rest are one hover away. */
  pinnedCount: number;
  /** Usage-rank namespace: each bar ranks its own templates by its own use. */
  usageNamespace: string;
  /** The order is frozen while this stays the same (e.g. the open conversation). */
  freezeKey: string;
  /** ✎ — put the template in the draft to edit. */
  onInsert: (t: TemplateChipItem) => void;
  /** ➤ — send it right away. */
  onSend: (t: TemplateChipItem) => void;
  /** Whether ➤ is live; ✎ always is. */
  canSend: boolean;
  /**
   * What the bar sits in — only the host knows, so it is required. It decides
   * the pinned strip only; the ✎ panel morphs open in place either way.
   *
   * `row`: a row that gives the bar its slack (the prompt bar). The strip is
   * adaptive — a chip that doesn't fit is dropped, it is still in the panel.
   *
   * `floating`: a shrink-to-content floating surface (the selection toolbar).
   * There is no slack to measure, so every pinned chip is drawn. The surface
   * must not clip what draws past it (`FloatingSurface scroll={false}`), or
   * the panel morphing open is cut to the toolbar's height.
   */
  host: "row" | "floating";
  /** The config the panel's gear opens. */
  config: ConfigDescriptor;
  configLabel: string;
  /**
   * Manage the templates in place, from the panel: + New template, and ✎ on
   * each row to rename, rewrite or delete it — the bar hands the whole list
   * back changed. Left out, the panel only lists them (and the config gear).
   */
  edit?: TemplateListEdit;
}

/**
 * A row of split template chips (✎ name inserts, ➤ sends): the most-used ones
 * pinned as a strip, and every one — with the config gear — in a panel that
 * opens from a ✎ trigger on hover. Usage is recorded here, on both use sites,
 * so the pinned strip and the panel can never drift apart.
 */
export function TemplateChipBar({
  templates,
  pinnedCount,
  usageNamespace,
  freezeKey,
  onInsert,
  onSend,
  canSend,
  host,
  config,
  configLabel,
  edit,
}: TemplateChipBarProps) {
  // Most-used first, frozen for as long as `freezeKey` holds (the primitive
  // owns the freeze). The authored config order stays the tie-break for
  // anything never used, so an untouched install looks exactly as before.
  const ids = useMemo(() => templates.map((t) => t.id), [templates]);
  const order = useUsageOrder(usageNamespace, ids, freezeKey);
  const recordUsage = useRecordUsage();

  // ONE derived array feeds both surfaces — the pinned strip is its head and
  // the panel is the whole of it, so the two can never disagree on the order.
  const ordered = useMemo(() => {
    const byId = new Map(templates.map((t) => [t.id, t]));
    return order.map((id) => {
      const t = byId.get(id);
      // `useUsageOrder` returns a permutation of the ids it was given; a miss
      // means that contract broke, and silently dropping the chip would hide it.
      if (!t) throw new Error(`No template for usage-ranked id: ${id}`);
      return t;
    });
  }, [order, templates]);

  const pinnedTemplates = useMemo(
    () => ordered.slice(0, pinnedCount),
    [ordered, pinnedCount],
  );

  const insert = (t: TemplateChipItem) => {
    recordUsage(usageNamespace, t.id);
    onInsert(t);
  };
  const send = (t: TemplateChipItem) => {
    if (!canSend) return;
    recordUsage(usageNamespace, t.id);
    onSend(t);
  };

  // A chip-high square, so the closed panel is exactly the xs chip height
  // it sits beside and, open, the ✎ lines up with the panel's footer row.
  const trigger = (
    <Center className="size-6">
      <Icon
        icon={editIcon}
        className="size-3 text-muted-foreground/40 group-data-open/fa:text-muted-foreground transition-colors"
      />
    </Center>
  );

  // The chips are a sub-region of their host bar, not lone controls, so THIS
  // is where their density is declared — one step below the bar's own. The
  // pinned strip and the panel sit inside the same provider so the two
  // surfaces can't drift apart.
  return (
    <ControlSizeProvider size="xs">
      <Stack direction="row" gap="xs" align="center">
        {host === "row" ? (
          // Drawn even with nothing pinned: the bar is what asks the row for
          // its slack, so without it the ✎ would drift to the row's start.
          //
            // `clip`, not a second `⋯`: a chip that doesn't fit is simply
            // dropped from the strip, because every template is already one
            // hover away in the panel beside it.
            //
            // `end`, because the bar holds this row's slack and therefore
            // decides where the row's empty space sits. Packed to the start,
            // the slack lands BETWEEN the last chip and the ✎ beside it —
            // splitting one control into two. Packed to the end, the strip and
            // its trigger stay one group and the empty space falls at the left.
            <AdaptiveBar gap="xs" overflow="clip" align="end">
              {pinnedTemplates.map((t) => (
                <AdaptiveBar.Item key={t.id} id={t.id}>
                  <TemplateChip
                    template={t}
                    onInsert={insert}
                    onSend={send}
                    pinned
                    canSend={canSend}
                  />
                </AdaptiveBar.Item>
              ))}
            </AdaptiveBar>
          ) : (
            pinnedTemplates.map((t) => (
              <TemplateChip
                key={t.id}
                template={t}
                onInsert={insert}
                onSend={send}
                pinned
                canSend={canSend}
              />
            ))
        )}
        {/* Sized to its content (`fit="content"`): opening, closing and every
            change inside (a row turning into its editor) animate the panel's
            real size. The ✎ sits at the bottom-right corner, beside the
            panel's footer row; the panel grows up and to the left from it. */}
        <FloatingAction
          className="relative z-popover"
          variant="ghost"
          fit="content"
          direction="row"
          triggerAt="end"
          align="end"
          gap="xs"
          trigger={trigger}
        >
          <FloatingActionFadeIn className="pt-xs pl-xs">
            <TemplatePanel
              ordered={ordered}
              templates={templates}
              onInsert={insert}
              onSend={send}
              canSend={canSend}
              edit={edit}
              config={config}
              configLabel={configLabel}
            />
          </FloatingActionFadeIn>
        </FloatingAction>
      </Stack>
    </ControlSizeProvider>
  );
}
