import { useState } from "react";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { WaitTimeChart } from "./wait-time-chart";
import { ThroughputChart } from "./throughput-chart";
import { StepBreakdownChart } from "./step-breakdown-chart";
import type { PushBucket } from "../../shared/values";

const BUCKETS: { id: PushBucket; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

export function PushesSection() {
  const [bucket, setBucket] = useState<PushBucket>("day");

  return (
    <Stack gap="xl">
      <SegmentedControl options={BUCKETS} value={bucket} onChange={setBucket} />
      <ThroughputChart bucket={bucket} />
      <WaitTimeChart bucket={bucket} />
      <StepBreakdownChart bucket={bucket} />
    </Stack>
  );
}
