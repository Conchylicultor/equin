import {
  ACCOUNT_SPEND_MONTH,
  claudeAccountSpend,
  type AccountSpendDay,
} from "@plugins/conversations/plugins/usage/core";
import { useClockParam, useLive } from "@plugins/network/plugins/live/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

// An API-key account's spend at a glance, in the sidebar foot's trigger:
// `$4.12 today · $86 in Nov` — what equin's own agents spent on it, at API
// prices (the usage sync files each newly counted cost under the account its
// agent ran on). Days are UTC, as the spend is filed.

const cents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Nothing as `$0`, cents below $10 (where they matter), whole dollars above. */
const formatSpend = (usd: number): string =>
  (usd === 0 || usd >= 10 ? dollars : cents).format(usd);

/** A `YYYY-MM` key's month, short (`Nov`). */
const monthName = (key: string): string =>
  new Date(`${key}-01T00:00:00Z`).toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });

/** Today's (UTC) and the month's spend, out of the month's days. */
function spendTotals(
  days: readonly AccountSpendDay[],
  now: number,
): { today: number; month: number } {
  const today = new Date(now).toISOString().slice(0, 10);
  let todayUsd = 0;
  let monthUsd = 0;
  for (const d of days) {
    if (d.date === today) todayUsd += d.costUsd;
    monthUsd += d.costUsd;
  }
  return { today: todayUsd, month: monthUsd };
}

export function AccountSpendGlance({
  accountId,
  now,
}: {
  accountId: string;
  now: number;
}) {
  const month = useClockParam(ACCOUNT_SPEND_MONTH);
  const read = useLive(claudeAccountSpend, { accountId, month });
  if (read.status === "loading")
    return (
      <Text variant="caption" tone="faint">
        Reading spend…
      </Text>
    );
  if (read.status === "error")
    return (
      <Text variant="caption" tone="destructive" title={read.error.message}>
        Spend unavailable
      </Text>
    );
  const spent = spendTotals(read.data.days, now);
  // One line, truncating in the narrow sidebar rather than wrapping.
  return (
    <Line>
      <Text
        variant="caption"
        tone="muted"
        className="tabular-nums"
        title="What equin's agents spent on this account, at API prices (UTC days). Spend outside equin is not counted."
      >
        {formatSpend(spent.today)} today · {formatSpend(spent.month)} in{" "}
        {monthName(month)}
      </Text>
    </Line>
  );
}
