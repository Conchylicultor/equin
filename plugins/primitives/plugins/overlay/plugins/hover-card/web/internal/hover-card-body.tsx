import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  cn,
  ControlSizeProvider,
  Separator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

import type {
  HoverCardContent,
  HoverCardFigures,
  HoverCardSteps,
} from "./with-hover-card";

// Past steps a quiet accent, the current one a strong accent, the rest a faint fill.
const SEGMENT = {
  done: "bg-primary/45",
  now: "bg-primary",
  todo: "bg-muted-foreground/25",
} as const;

/** The one layout of a hover card's parts, top to bottom. */
export function HoverCardBody({ card }: { card: HoverCardContent }) {
  const {
    title,
    code,
    description,
    chips,
    steps,
    figures,
    lists,
    notice,
    meta,
    hint,
  } = card;
  return (
    <Stack gap="xs">
      <Cluster gap="xs" align="baseline">
        <Text variant="label" className="font-semibold">
          {title}
        </Text>
        {code != null && (
          <Text variant="code" tone="faint">
            {code}
          </Text>
        )}
      </Cluster>
      {description != null && (
        <Text variant="caption" tone="muted">
          {description}
        </Text>
      )}
      {chips != null && chips.length > 0 && (
        // The compact chip rung: a card's chips are tags, not controls.
        <ControlSizeProvider size="xs">
          <Cluster gap="2xs">
            {chips.map((chip) => (
              <Badge key={chip.label} variant={chip.off ? "absent" : "muted"}>
                {chip.label}
              </Badge>
            ))}
          </Cluster>
        </ControlSizeProvider>
      )}
      {steps != null && <StepsPath steps={steps} />}
      {figures != null && <FiguresTable figures={figures} />}
      {lists?.map((list) => (
        <Stack key={list.label} gap="2xs">
          <Text variant="caption" tone="faint">
            {list.label}
          </Text>
          {list.items.map((item) => (
            <Text
              key={item.key ?? item.text}
              as="div"
              variant="caption"
              tone={item.muted ? "muted" : "default"}
            >
              {item.text}
            </Text>
          ))}
        </Stack>
      ))}
      {notice != null && (
        <Text variant="caption" tone="destructive">
          {notice}
        </Text>
      )}
      {meta != null && meta.length > 0 && (
        <Text variant="code" tone="faint">
          {meta.join(" · ")}
        </Text>
      )}
      {hint != null && (
        <Text variant="caption" tone="faint">
          {hint}
        </Text>
      )}
    </Stack>
  );
}

/**
 * The path as a stepper: one equal segment per step with its name under it,
 * the current one lit, then what the current step means.
 */
function StepsPath({ steps }: { steps: HoverCardSteps }) {
  const { items, current, caption } = steps;
  return (
    <Stack gap="xs">
      <Grid as="ol" cols={items.length} gap="sm">
        {items.map((step, i) => {
          const state = i < current ? "done" : i === current ? "now" : "todo";
          return (
            <Stack as="li" key={step.id} gap="2xs">
              <span className={cn("h-1 rounded-sm", SEGMENT[state])} />
              <Text
                variant="caption"
                tone={state === "now" ? "default" : "muted"}
                className={cn(state === "now" && "font-medium")}
              >
                {step.label}
              </Text>
            </Stack>
          );
        })}
      </Grid>
      {caption != null && (
        <Text variant="caption" tone="muted">
          {caption}
        </Text>
      )}
    </Stack>
  );
}

/** Label left, value right in tabular digits; a total row is ruled off above. */
function FiguresTable({ figures }: { figures: HoverCardFigures }) {
  const { label, rows } = figures;
  return (
    <Stack gap="2xs">
      {label != null && (
        <Text variant="caption" tone="faint">
          {label}
        </Text>
      )}
      {rows.map((row) => (
        <Stack key={row.label} gap="2xs">
          {row.total === true && <Separator />}
          <Stack direction="row" justify="between" align="baseline" gap="md">
            <Text
              variant="caption"
              tone={row.total === true ? "default" : "muted"}
              className={cn(row.total === true && "font-medium")}
            >
              {row.label}
            </Text>
            <Text
              variant="caption"
              tone={row.total === true ? "strong" : "default"}
              className={cn(
                "tabular-nums",
                row.total === true && "font-semibold",
              )}
            >
              {row.value}
            </Text>
          </Stack>
        </Stack>
      ))}
    </Stack>
  );
}
