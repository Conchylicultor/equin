import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

import type { HoverCardContent, HoverCardSteps } from "./with-hover-card";

// Past steps a quiet accent, the current one a strong accent, the rest a faint fill.
const SEGMENT = {
  done: "bg-primary/45",
  now: "bg-primary",
  todo: "bg-muted-foreground/25",
} as const;

/** The one layout of a hover card's parts, top to bottom. */
export function HoverCardBody({ card }: { card: HoverCardContent }) {
  const { title, code, description, chips, steps, lists, notice, meta } = card;
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
    </Stack>
  );
}

/**
 * The path as a vertical stepper: one line per step, its marker lit up to the
 * current one, then what the current step means. One line each, not a row of
 * columns: a fixed-width card cannot fit any path's names side by side (the
 * trigger is usually the horizontal bar already).
 */
function StepsPath({ steps }: { steps: HoverCardSteps }) {
  const { items, current, caption } = steps;
  return (
    <Stack gap="xs">
      <Stack as="ol" gap="2xs">
        {items.map((step, i) => {
          const state = i < current ? "done" : i === current ? "now" : "todo";
          return (
            <Stack
              as="li"
              key={step.id}
              direction="row"
              gap="xs"
              align="center"
            >
              <span
                className={cn(
                  "h-1 w-3 rounded-sm",
                  rigidClass(),
                  SEGMENT[state],
                )}
              />
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
      </Stack>
      {caption != null && (
        <Text variant="caption" tone="muted">
          {caption}
        </Text>
      )}
    </Stack>
  );
}
