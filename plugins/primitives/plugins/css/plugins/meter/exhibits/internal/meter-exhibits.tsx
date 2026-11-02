import { useState, type ReactNode } from "react";
import {
  isolatedExhibit,
  type Exhibit,
} from "@plugins/plugin-meta/plugins/exhibits/core";
import { Meter } from "@plugins/primitives/plugins/css/plugins/meter/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

function Labelled({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}): ReactNode {
  return (
    <Stack gap="2xs">
      <Text variant="caption" tone="muted">
        {caption}
      </Text>
      {children}
    </Stack>
  );
}

/** Every tone and size, a pace marker, an overfull reading, and a stepper to
 * watch the width transition. */
function MeterGallery(): ReactNode {
  const [step, setStep] = useState(3);
  return (
    <Inset pad="md">
      <Stack gap="md">
        <Labelled caption="default · 51% · pace marker at 32%">
          <Meter
            value={0.51}
            label="Week usage"
            marker={0.32}
            markerLabel="An even pace through the week"
          />
        </Labelled>
        <Labelled caption="warning · 84%">
          <Meter value={0.84} label="Week usage" tone="warning" />
        </Labelled>
        <Labelled caption="destructive · over 1 draws full">
          <Meter value={1.3} label="Week usage" tone="destructive" />
        </Labelled>
        <Labelled caption="muted · 40%">
          <Meter value={0.4} label="Share" tone="muted" />
        </Labelled>
        <Labelled caption="thin · 62% · marker at 70%">
          <Meter
            value={0.62}
            label="Session usage"
            size="thin"
            marker={0.7}
            markerLabel="Target"
          />
        </Labelled>
        <Labelled caption={`progressbar · ${String(step)} / 10`}>
          <Meter value={step / 10} label="Scan progress" role="progressbar" />
        </Labelled>
        <Stack direction="row" gap="xs">
          <Button
            variant="secondary"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            Less
          </Button>
          <Button
            variant="secondary"
            onClick={() => setStep((s) => Math.min(10, s + 1))}
          >
            More
          </Button>
        </Stack>
      </Stack>
    </Inset>
  );
}

export const meterExhibits: Exhibit[] = [
  isolatedExhibit({
    id: "meter/gallery",
    label: "Meter — tones, sizes, marker",
    widths: [480, 240],
    render: () => <MeterGallery />,
  }),
];
